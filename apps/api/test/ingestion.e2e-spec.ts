import type { NestExpressApplication } from '@nestjs/platform-express';
import pg from 'pg';
import request from 'supertest';
import { bearer, createTestApp, setupProjectWithKey } from './test-app.js';

const t = (offsetMs: number) =>
  new Date(Date.parse('2026-11-05T12:00:00.000Z') + offsetMs).toISOString();

describe('Telemetry ingestion (e2e)', () => {
  let app: NestExpressApplication;
  let pool: pg.Pool;

  beforeAll(async () => {
    app = await createTestApp();
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
    await pool.query(
      `INSERT INTO model_pricing (provider_id, model, input_price_per_million, output_price_per_million, cached_input_price_per_million, effective_from, source)
       VALUES ('openai', 'test-model', 2.5, 10, 1.25, '2026-01-01', 'test fixture')`,
    );
  });

  afterAll(async () => {
    await pool.end();
    await app.close();
  });

  const send = (key: string, events: unknown[]) =>
    request(app.getHttpServer()).post('/v1/ingest/batch').set(bearer(key)).send({ events });

  const query = async <T extends Record<string, unknown>>(text: string, params: unknown[] = []) =>
    (await pool.query<T>(text, params)).rows;

  /** Ingestion is asynchronous: wait until the worker has persisted what the assertion needs. */
  const eventually = (assertion: () => Promise<void>) =>
    vi.waitFor(assertion, { timeout: 10_000, interval: 50 });

  it('persists a trace with nested spans, token usage and estimated cost', async () => {
    const { key, projectId } = await setupProjectWithKey(app);

    const response = await send(key, [
      // Child before parent on purpose: ordering must not matter.
      {
        type: 'span',
        id: 'llm-1',
        traceId: 'trace-1',
        parentId: 'agent-1',
        name: 'generate-answer',
        provider: 'openai',
        model: 'test-model',
        input: [{ role: 'user', content: 'Where is my order?' }],
        output: { role: 'assistant', content: 'It ships tomorrow.' },
        modelParameters: { temperature: 0.2 },
        usage: { inputTokens: 1000, outputTokens: 500, cachedInputTokens: 400 },
        startTime: t(100),
        endTime: t(1_300),
      },
      {
        type: 'span',
        id: 'agent-1',
        traceId: 'trace-1',
        name: 'support-agent',
        kind: 'chain',
        startTime: t(0),
        endTime: t(1_500),
      },
      {
        type: 'trace',
        id: 'trace-1',
        name: 'customer-support',
        userId: 'end-user-42',
        sessionId: 'session-7',
        tags: ['support'],
        input: 'Where is my order?',
        startTime: t(0),
        endTime: t(1_600),
      },
    ]).expect(202);

    expect(response.body).toMatchObject({ accepted: 3, rejected: [], batchId: expect.any(String) });

    await eventually(async () => {
      const [trace] = await query(
        `SELECT name, environment, status, end_user_id, duration_ms, is_complete FROM traces WHERE project_id = $1`,
        [projectId],
      );
      expect(trace).toEqual({
        name: 'customer-support',
        environment: 'production',
        status: 'success',
        end_user_id: 'end-user-42',
        duration_ms: 1600,
        is_complete: true,
      });
    });

    const spans = await query(
      `SELECT s.external_id, s.kind, s.status, s.duration_ms, p.external_id AS parent
       FROM spans s LEFT JOIN spans p ON p.id = s.parent_span_id
       WHERE s.project_id = $1 ORDER BY s.started_at`,
      [projectId],
    );
    expect(spans).toEqual([
      { external_id: 'agent-1', kind: 'chain', status: 'success', duration_ms: 1500, parent: null },
      {
        external_id: 'llm-1',
        kind: 'llm',
        status: 'success',
        duration_ms: 1200,
        parent: 'agent-1',
      },
    ]);

    const [usage] = await query(
      `SELECT input_tokens, output_tokens, cached_input_tokens, total_tokens, estimated_cost_usd, reported_cost_usd, pricing_id IS NOT NULL AS priced
       FROM token_usage WHERE project_id = $1`,
      [projectId],
    );
    // 600 × 2.5/1M + 400 × 1.25/1M + 500 × 10/1M = 0.0015 + 0.0005 + 0.005
    expect(usage).toEqual({
      input_tokens: 1000,
      output_tokens: 500,
      cached_input_tokens: 400,
      total_tokens: 1500,
      estimated_cost_usd: '0.00700000',
      reported_cost_usd: null,
      priced: true,
    });
  });

  it('merges partial updates and is idempotent under retries', async () => {
    const { key, projectId } = await setupProjectWithKey(app);
    const start = {
      type: 'span',
      id: 's1',
      traceId: 'tr',
      name: 'call',
      input: 'question',
      startTime: t(0),
    };
    const end = { type: 'span', id: 's1', traceId: 'tr', output: 'answer', endTime: t(250) };

    await send(key, [start]).expect(202);
    await send(key, [end]).expect(202);
    await send(key, [start, end]).expect(202); // full replay

    await eventually(async () => {
      const rows = await query(
        `SELECT name, input, output, status, duration_ms FROM spans WHERE project_id = $1`,
        [projectId],
      );
      expect(rows).toEqual([
        { name: 'call', input: 'question', output: 'answer', status: 'success', duration_ms: 250 },
      ]);
    });
    const [traceCount] = await query<{ total: string }>(
      `SELECT count(*) AS total FROM traces WHERE project_id = $1`,
      [projectId],
    );
    expect(Number(traceCount?.total)).toBe(1);
  });

  it('creates a placeholder trace for early spans and completes it later', async () => {
    const { key, projectId } = await setupProjectWithKey(app);
    await send(key, [{ type: 'span', id: 'a', traceId: 'late', startTime: t(500) }]).expect(202);

    await eventually(async () => {
      const [trace] = await query(`SELECT name, is_complete FROM traces WHERE project_id = $1`, [
        projectId,
      ]);
      expect(trace).toEqual({ name: '(pending trace)', is_complete: false });
    });

    await send(key, [
      { type: 'trace', id: 'late', name: 'arrived', startTime: t(0), endTime: t(900) },
    ]).expect(202);
    await eventually(async () => {
      const [trace] = await query(
        `SELECT name, is_complete, status, started_at = $2::timestamptz AS start_ok FROM traces WHERE project_id = $1`,
        [projectId, t(0)],
      );
      expect(trace).toEqual({
        name: 'arrived',
        is_complete: true,
        status: 'success',
        start_ok: true,
      });
    });
  });

  it('accepts valid events, rejects invalid ones individually and records the rejections', async () => {
    const { key, projectId, owner } = await setupProjectWithKey(app);
    const response = await send(key, [
      { type: 'trace', id: 'ok-1', name: 'fine' },
      { type: 'span', id: 'bad', traceId: 'ok-1', usage: { inputTokens: -5 } },
      { type: 'nonsense' },
      { type: 'evaluation', traceId: 'ok-1', criterion: 'helpful', kind: 'thumbs', score: 0.5 },
      { type: 'span', id: 'x', traceId: 'ok-1', startTime: t(10), endTime: t(0) },
    ]).expect(202);

    expect(response.body.accepted).toBe(1);
    expect(response.body.rejected.map((r: { index: number }) => r.index)).toEqual([1, 2, 3, 4]);
    expect(response.body.rejected[0]).toMatchObject({
      eventId: 'bad',
      issues: expect.arrayContaining([expect.objectContaining({ path: 'usage.inputTokens' })]),
    });

    const status = await request(app.getHttpServer())
      .get(`/v1/projects/${projectId}/ingestion`)
      .set(bearer(owner.accessToken))
      .expect(200);
    expect(status.body.recentFailures).toHaveLength(4);
    expect(status.body.recentFailures[0].reason).toMatch(/^validation:/);
  });

  it('rejects malformed envelopes', async () => {
    const { key } = await setupProjectWithKey(app);
    await request(app.getHttpServer())
      .post('/v1/ingest/batch')
      .set(bearer(key))
      .send({ events: [] })
      .expect(400);
    await request(app.getHttpServer())
      .post('/v1/ingest/batch')
      .set(bearer(key))
      .send({ nope: true })
      .expect(400);
    await request(app.getHttpServer())
      .post('/v1/ingest/batch')
      .set(bearer(key))
      .send({ events: Array.from({ length: 1001 }, (_, i) => ({ type: 'trace', id: `t${i}` })) })
      .expect(400);
    await request(app.getHttpServer())
      .post('/v1/ingest/batch')
      .set(bearer(key))
      .set('Content-Type', 'application/json')
      .send('{"events": [')
      .expect(400);
  });

  it('redacts secrets and personal data before anything is stored', async () => {
    const { key, projectId } = await setupProjectWithKey(app);
    const secret = `sk-proj-${'Z9'.repeat(20)}`;
    await send(key, [
      {
        type: 'span',
        id: 'leaky',
        traceId: 'r1',
        input: {
          messages: [{ role: 'user', content: `my key is ${secret}, email me at ana@cliente.com` }],
        },
        metadata: { headers: { authorization: 'Bearer abc', 'x-region': 'br' } },
      },
    ]).expect(202);

    await eventually(async () => {
      const [span] = await query<{ text: string }>(
        `SELECT input::text || metadata::text AS text FROM spans WHERE project_id = $1`,
        [projectId],
      );
      expect(span).toBeDefined();
      expect(span!.text).not.toContain(secret);
      expect(span!.text).not.toContain('ana@cliente.com');
      expect(span!.text).toContain('[REDACTED:openai_key]');
      expect(span!.text).toContain('[REDACTED:sensitive_key]');
      expect(span!.text).toContain('br');
    });
  });

  it('honours per-project redaction settings', async () => {
    const { key, projectId, owner } = await setupProjectWithKey(app);
    await request(app.getHttpServer())
      .patch(`/v1/projects/${projectId}`)
      .set(bearer(owner.accessToken))
      .send({
        redaction: {
          enabled: true,
          maskEmails: false,
          maskPhoneNumbers: false,
          literals: ['Projeto Fênix'],
        },
      })
      .expect(200);

    // Settings are cached for up to 30 s per process; a fresh app reads them immediately.
    const fresh = await createTestApp();
    try {
      await request(fresh.getHttpServer())
        .post('/v1/ingest/batch')
        .set(bearer(key))
        .send({
          events: [{ type: 'trace', id: 'cfg', input: 'Projeto Fênix — contato: ana@cliente.com' }],
        })
        .expect(202);
      await eventually(async () => {
        const [trace] = await query<{ input: string }>(
          `SELECT input FROM traces WHERE project_id = $1`,
          [projectId],
        );
        expect(trace?.input).toBe('[REDACTED:literal] — contato: ana@cliente.com');
      });
    } finally {
      await fresh.close();
    }
  });

  it('records span and trace errors and keeps the error status when the trace ends', async () => {
    const { key, projectId } = await setupProjectWithKey(app);
    await send(key, [
      {
        type: 'span',
        id: 'fail',
        traceId: 'err-trace',
        provider: 'anthropic',
        model: 'some-model',
        startTime: t(0),
        endTime: t(30_000),
        error: { type: 'rate_limit', message: 'Too many requests', httpStatus: 429 },
      },
      { type: 'trace', id: 'err-trace', name: 'checkout', status: 'error', startTime: t(0) },
    ]).expect(202);
    await send(key, [{ type: 'trace', id: 'err-trace', endTime: t(31_000) }]).expect(202);

    await eventually(async () => {
      const [trace] = await query(`SELECT status, duration_ms FROM traces WHERE project_id = $1`, [
        projectId,
      ]);
      expect(trace).toEqual({ status: 'error', duration_ms: 31000 });
    });
    const errors = await query(
      `SELECT e.type, e.http_status, e.provider_id, e.model, s.external_id AS span
       FROM errors e JOIN spans s ON s.id = e.span_id WHERE e.project_id = $1`,
      [projectId],
    );
    expect(errors).toEqual([
      {
        type: 'rate_limit',
        http_status: 429,
        provider_id: 'anthropic',
        model: 'some-model',
        span: 'fail',
      },
    ]);
    const [span] = await query(`SELECT status FROM spans WHERE project_id = $1`, [projectId]);
    expect(span).toEqual({ status: 'error' });
  });

  it('registers unknown providers and leaves cost empty when no price is known', async () => {
    const { key, projectId } = await setupProjectWithKey(app);
    await send(key, [
      {
        type: 'span',
        id: 'm',
        traceId: 'p',
        provider: 'Mistral',
        model: 'unknown-model',
        usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.0001 },
      },
    ]).expect(202);

    await eventually(async () => {
      const [row] = await query(
        `SELECT s.provider_id, u.estimated_cost_usd, u.reported_cost_usd
         FROM spans s JOIN token_usage u ON u.span_id = s.id WHERE s.project_id = $1`,
        [projectId],
      );
      expect(row).toEqual({
        provider_id: 'mistral',
        estimated_cost_usd: null,
        reported_cost_usd: '0.00010000',
      });
    });
  });

  it('stores evaluations idempotently when an id is given', async () => {
    const { key, projectId } = await setupProjectWithKey(app);
    const evaluation = {
      type: 'evaluation',
      id: 'fb-1',
      traceId: 'ev',
      criterion: 'user_feedback',
      kind: 'thumbs',
      score: 1,
    };
    await send(key, [{ type: 'trace', id: 'ev', name: 'chat' }, evaluation]).expect(202);
    await send(key, [{ ...evaluation, score: 0, comment: 'changed my mind' }]).expect(202);
    await send(key, [
      { type: 'evaluation', traceId: 'ev', criterion: 'accuracy', kind: 'numeric', score: 0.8 },
    ]).expect(202);

    await eventually(async () => {
      const rows = await query(
        `SELECT criterion, kind, score, comment, source FROM evaluations WHERE project_id = $1 ORDER BY criterion`,
        [projectId],
      );
      expect(rows).toEqual([
        { criterion: 'accuracy', kind: 'numeric', score: 0.8, comment: null, source: 'api' },
        {
          criterion: 'user_feedback',
          kind: 'thumbs',
          score: 0,
          comment: 'changed my mind',
          source: 'api',
        },
      ]);
    });
  });

  it('retries batches that reference data not yet ingested, then dead-letters them', async () => {
    const { key, projectId } = await setupProjectWithKey(app);
    await send(key, [
      {
        type: 'evaluation',
        traceId: 'ghost',
        spanId: 'never-arrives',
        criterion: 'x',
        kind: 'numeric',
        score: 1,
      },
    ]).expect(202);

    await eventually(async () => {
      const rows = await query<{ reason: string }>(
        `SELECT reason FROM ingestion_failures WHERE project_id = $1 AND reason LIKE 'processing:%'`,
        [projectId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.reason).toContain('never-arrives');
    });
  });

  it('isolates projects: a key writes only to its own project', async () => {
    const first = await setupProjectWithKey(app);
    const second = await setupProjectWithKey(app);
    await send(first.key, [{ type: 'trace', id: 'shared-id', name: 'first' }]).expect(202);
    await send(second.key, [{ type: 'trace', id: 'shared-id', name: 'second' }]).expect(202);

    await eventually(async () => {
      const rows = await query(
        `SELECT project_id, name FROM traces WHERE external_id = 'shared-id' AND project_id IN ($1, $2) ORDER BY name`,
        [first.projectId, second.projectId],
      );
      expect(rows).toEqual([
        { project_id: first.projectId, name: 'first' },
        { project_id: second.projectId, name: 'second' },
      ]);
    });
  });

  it('requires a valid API key and never accepts dashboard sessions', async () => {
    const { owner } = await setupProjectWithKey(app);
    await request(app.getHttpServer())
      .post('/v1/ingest/batch')
      .send({ events: [{ type: 'trace', id: 'x' }] })
      .expect(401);
    await request(app.getHttpServer())
      .post('/v1/ingest/batch')
      .set(bearer(owner.accessToken))
      .send({ events: [{ type: 'trace', id: 'x' }] })
      .expect(401);
  });

  describe('OTLP/HTTP JSON', () => {
    const otlpBody = (traceId: string) => ({
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: 'service.name', value: { stringValue: 'support-bot' } },
              { key: 'deployment.environment.name', value: { stringValue: 'staging' } },
            ],
          },
          scopeSpans: [
            {
              scope: { name: 'opentelemetry.instrumentation.openai' },
              spans: [
                {
                  traceId,
                  spanId: '1111111111111111',
                  name: 'POST /chat',
                  startTimeUnixNano: '1793880000000000000',
                  endTimeUnixNano: '1793880002000000000',
                  attributes: [{ key: 'http.route', value: { stringValue: '/chat' } }],
                  status: {},
                },
                {
                  traceId,
                  spanId: '2222222222222222',
                  parentSpanId: '1111111111111111',
                  name: 'chat test-model',
                  startTimeUnixNano: '1793880000100000000',
                  endTimeUnixNano: '1793880001900000000',
                  attributes: [
                    { key: 'gen_ai.operation.name', value: { stringValue: 'chat' } },
                    { key: 'gen_ai.provider.name', value: { stringValue: 'openai' } },
                    { key: 'gen_ai.request.model', value: { stringValue: 'test-model' } },
                    { key: 'gen_ai.request.temperature', value: { doubleValue: 0.3 } },
                    { key: 'gen_ai.usage.input_tokens', value: { intValue: '200' } },
                    { key: 'gen_ai.usage.output_tokens', value: { intValue: '100' } },
                    {
                      key: 'gen_ai.input.messages',
                      value: {
                        stringValue: JSON.stringify([
                          { role: 'user', parts: [{ type: 'text', content: 'hi' }] },
                        ]),
                      },
                    },
                  ],
                  status: { code: 1 },
                },
                { traceId, spanId: 'not-hex', name: 'broken', startTimeUnixNano: '1' },
              ],
            },
          ],
        },
      ],
    });

    it('maps GenAI spans to traces, spans and token usage', async () => {
      const { key, projectId } = await setupProjectWithKey(app, 'development');
      const traceId = 'abcdef0123456789abcdef0123456789';

      const response = await request(app.getHttpServer())
        .post('/v1/ingest/otlp/v1/traces')
        .set(bearer(key))
        .send(otlpBody(traceId))
        .expect(200);
      expect(response.body.partialSuccess).toMatchObject({ rejectedSpans: 1 });

      await eventually(async () => {
        const [trace] = await query(
          `SELECT name, environment, metadata->>'service.name' AS service, duration_ms FROM traces WHERE project_id = $1`,
          [projectId],
        );
        expect(trace).toEqual({
          name: 'POST /chat',
          environment: 'staging',
          service: 'support-bot',
          duration_ms: 2000,
        });
        const [llm] = await query(
          `SELECT s.kind, s.provider_id, s.model, s.model_parameters, s.input, p.external_id AS parent,
                  u.input_tokens, u.output_tokens, u.estimated_cost_usd
           FROM spans s JOIN spans p ON p.id = s.parent_span_id JOIN token_usage u ON u.span_id = s.id
           WHERE s.project_id = $1`,
          [projectId],
        );
        expect(llm).toEqual({
          kind: 'llm',
          provider_id: 'openai',
          model: 'test-model',
          model_parameters: { temperature: 0.3 },
          input: [{ role: 'user', parts: [{ type: 'text', content: 'hi' }] }],
          parent: '1111111111111111',
          input_tokens: 200,
          output_tokens: 100,
          // 200 × 2.5/1M + 100 × 10/1M
          estimated_cost_usd: '0.00150000',
        });
      });
    });

    it('rejects protobuf with 415 and explains how to switch to JSON', async () => {
      const { key } = await setupProjectWithKey(app);
      const response = await request(app.getHttpServer())
        .post('/v1/ingest/otlp/v1/traces')
        .set(bearer(key))
        .set('Content-Type', 'application/x-protobuf')
        .send(Buffer.from([0x0a, 0x00]))
        .expect(415);
      expect(response.body.message).toMatch(/encoding: json/);
    });
  });

  it('applies the per-key ingestion rate limit independently of the dashboard limit', async () => {
    // Limits are configured high in tests; verify the ingest throttler is the one reporting.
    const { key } = await setupProjectWithKey(app);
    const response = await send(key, [{ type: 'trace', id: 'rl' }]).expect(202);
    expect(response.headers['x-ratelimit-limit-ingest']).toBe('10000');
    expect(response.headers['x-ratelimit-limit']).toBeUndefined();
  });
});
