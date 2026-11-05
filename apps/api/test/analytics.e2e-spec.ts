import type { NestExpressApplication } from '@nestjs/platform-express';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import request from 'supertest';
import { estimateCostUsd } from '../src/ingestion/cost.js';
import { recomputeCosts } from '../src/pricing/pricing-sync.js';
import { bearer, createTestApp, registerUser, setupProjectWithKey } from './test-app.js';

/** Reference implementation of PostgreSQL's percentile_cont (linear interpolation). */
function percentileCont(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const position = fraction * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
}

const BASE = Date.parse('2026-11-01T12:00:00.000Z');
const at = (minutes: number) => new Date(BASE + minutes * 60_000).toISOString();

describe('Analytics (e2e)', () => {
  let app: NestExpressApplication;
  let pool: pg.Pool;
  let token: string;
  let projectId: string;
  const durations: number[] = [];

  /** Inserts a trace with one LLM span, usage and optional error — fully deterministic data. */
  async function seedCall(input: {
    minute: number;
    durationMs: number;
    model: string;
    provider?: string;
    environment?: 'production' | 'staging';
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    error?: 'timeout' | 'rate_limit';
  }) {
    const started = at(input.minute);
    const ended = new Date(Date.parse(started) + input.durationMs).toISOString();
    const {
      rows: [trace],
    } = await pool.query<{ id: string }>(
      `INSERT INTO traces (project_id, external_id, name, environment, status, started_at, ended_at, duration_ms)
       VALUES ($1, $2, 'support', $3, $4, $5, $6, $7) RETURNING id`,
      [
        projectId,
        `t-${input.minute}-${input.model}`,
        input.environment ?? 'production',
        input.error ? 'error' : 'success',
        started,
        ended,
        input.durationMs,
      ],
    );
    const {
      rows: [span],
    } = await pool.query<{ id: string }>(
      `INSERT INTO spans (trace_id, project_id, external_id, name, kind, status, provider_id, model, started_at, ended_at, duration_ms)
       VALUES ($1, $2, 's', 'answer', 'llm', $3, $4, $5, $6, $7, $8) RETURNING id`,
      [
        trace!.id,
        projectId,
        input.error ? 'error' : 'success',
        input.provider ?? 'openai',
        input.model,
        started,
        ended,
        input.durationMs,
      ],
    );
    await pool.query(
      `INSERT INTO token_usage (span_id, project_id, input_tokens, output_tokens, cached_input_tokens, total_tokens, recorded_at)
       VALUES ($1, $2, $3::int, $4::int, $5, $3::int + $4::int, $6)`,
      [
        span!.id,
        projectId,
        input.inputTokens ?? 1000,
        input.outputTokens ?? 100,
        input.cachedInputTokens ?? 0,
        started,
      ],
    );
    if (input.error) {
      await pool.query(
        `INSERT INTO errors (project_id, trace_id, span_id, type, message, provider_id, model, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          projectId,
          trace!.id,
          span!.id,
          input.error,
          `${input.error} happened`,
          input.provider ?? 'openai',
          input.model,
          ended,
        ],
      );
    }
  }

  const get = (path: string, query: Record<string, string> = {}) =>
    request(app.getHttpServer())
      .get(`/v1/projects/${projectId}/analytics/${path}`)
      .query({ from: at(-60), to: at(24 * 60), ...query })
      .set(bearer(token));

  beforeAll(async () => {
    app = await createTestApp();
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
    const setup = await setupProjectWithKey(app);
    token = setup.owner.accessToken;
    projectId = setup.projectId;

    await pool.query(
      `INSERT INTO model_pricing (provider_id, model, input_price_per_million, output_price_per_million, cached_input_price_per_million, effective_from, source)
       VALUES ('openai', 'priced-model', 2, 8, 0.5, '1970-01-01', 'test'),
              ('anthropic', 'other-model', 3, 15, NULL, '1970-01-01', 'test')
       ON CONFLICT DO NOTHING`,
    );

    // Ten production calls with durations 100..1000 ms, one per minute.
    for (let i = 1; i <= 10; i += 1) {
      durations.push(i * 100);
      await seedCall({
        minute: i,
        durationMs: i * 100,
        model: 'priced-model',
        cachedInputTokens: i === 1 ? 400 : 0,
      });
    }
    // Staging calls on another provider, including failures.
    await seedCall({
      minute: 30,
      durationMs: 5_000,
      model: 'other-model',
      provider: 'anthropic',
      environment: 'staging',
      error: 'timeout',
    });
    await seedCall({
      minute: 31,
      durationMs: 50,
      model: 'other-model',
      provider: 'anthropic',
      environment: 'staging',
      error: 'rate_limit',
    });
    // An unpriced model.
    await seedCall({ minute: 40, durationMs: 300, model: 'mystery-model' });
    // Outside the range: must never be counted.
    await seedCall({ minute: -24 * 60, durationMs: 99_999, model: 'priced-model' });

    await recomputeCosts(drizzle(pool), { projectId });
  });

  afterAll(async () => {
    await pool.end();
    await app.close();
  });

  it('computes totals and exact percentiles over the filtered range', async () => {
    const { body } = await get('overview', {
      environment: 'production',
      model: 'priced-model',
    }).expect(200);
    expect(body.current).toMatchObject({
      requests: 10,
      traces: 10,
      errors: 0,
      inputTokens: 10_000,
      outputTokens: 1_000,
      cachedInputTokens: 400,
      unpricedRequests: 0,
      avgLatencyMs: 550,
      p50LatencyMs: Math.round(percentileCont(durations, 0.5)),
      p95LatencyMs: Math.round(percentileCont(durations, 0.95)),
      p99LatencyMs: Math.round(percentileCont(durations, 0.99)),
    });
    // 10 × (1000 in × 2 + 100 out × 8)/1M, with 400 of the first call's input at 0.5 instead of 2.
    expect(body.current.estimatedCostUsd).toBe('0.02740000');
    expect(body.previous.requests).toBe(1);
  });

  it('counts errors, timeouts and rate limits, and flags unpriced usage', async () => {
    const { body } = await get('overview').expect(200);
    expect(body.current).toMatchObject({
      requests: 13,
      errors: 2,
      timeouts: 1,
      rateLimits: 1,
      unpricedRequests: 1,
    });
    expect(body.current.errorRate).toBeCloseTo(2 / 13, 10);
  });

  it('matches the SQL cost recomputation with the TypeScript estimator', async () => {
    const { rows } = await pool.query<{
      estimated_cost_usd: string;
      input_tokens: number;
      output_tokens: number;
      cached_input_tokens: number;
    }>(
      `SELECT u.* FROM token_usage u JOIN spans s ON s.id = u.span_id WHERE s.project_id = $1 AND s.model = 'priced-model'`,
      [projectId],
    );
    const price = {
      inputPricePerMillion: '2',
      outputPricePerMillion: '8',
      cachedInputPricePerMillion: '0.5',
    };
    for (const row of rows) {
      expect(row.estimated_cost_usd).toBe(
        estimateCostUsd(
          {
            inputTokens: row.input_tokens,
            outputTokens: row.output_tokens,
            cachedInputTokens: row.cached_input_tokens,
          },
          price,
        ),
      );
    }
  });

  it('returns gap-free time series bucketed in the caller time zone', async () => {
    const { body } = await get('timeseries', {
      from: '2026-11-01T04:00:00.000Z', // midnight in Manaus (UTC-4)
      to: '2026-11-03T04:00:00.000Z', // 48 h → hourly buckets
      tz: 'America/Manaus',
    }).expect(200);
    expect(body.bucket).toBe('1 hour');
    expect(body.points).toHaveLength(48);
    expect(body.points[0].t).toBe('2026-11-01T04:00:00.000Z');
    const busy = body.points.find((point: { t: string }) => point.t === '2026-11-01T12:00:00.000Z');
    // The 12:00 bucket holds every in-range call (minutes 1–40).
    expect(busy).toMatchObject({
      requests: 13,
      errors: 2,
      p50LatencyMs: Math.round(percentileCont([...durations, 5_000, 50, 300], 0.5)),
    });

    const daily = await get('timeseries', {
      from: '2026-10-01T04:00:00.000Z',
      to: '2026-11-15T04:00:00.000Z',
      tz: 'America/Manaus',
    }).expect(200);
    expect(daily.body.bucket).toBe('1 day');
    // Daily buckets start at local midnight (04:00Z), not UTC midnight.
    expect(
      daily.body.points.every((point: { t: string }) => point.t.endsWith('T04:00:00.000Z')),
    ).toBe(true);
  });

  it('breaks down by model and provider with cost shares', async () => {
    const byModel = (await get('breakdown').expect(200)).body as Array<{
      model: string;
      requests: number;
      costShare: number;
    }>;
    // Ordered by cost: priced 0.0274 > other 2 × (1000 × 3 + 100 × 15)/1M = 0.009 > unpriced.
    expect(byModel.map((row) => row.model)).toEqual([
      'priced-model',
      'other-model',
      'mystery-model',
    ]);
    expect(byModel.reduce((sum, row) => sum + row.costShare, 0)).toBeCloseTo(1, 10);

    const byProvider = (await get('breakdown', { by: 'provider' }).expect(200)).body;
    expect(
      byProvider.map((row: { provider: string; requests: number }) => [row.provider, row.requests]),
    ).toEqual([
      ['openai', 11],
      ['anthropic', 2],
    ]);
    await get('breakdown', { by: 'nope' }).expect(400);
  });

  it('splits costs into input, cached input and output and lists the most expensive requests', async () => {
    const { body } = await get('costs', { model: 'priced-model' }).expect(200);
    expect(body).toMatchObject({
      estimatedCostUsd: '0.02740000',
      inputCostUsd: '0.01920000', // (10 000 − 400) × 2 / 1M
      cachedInputCostUsd: '0.00020000', // 400 × 0.5 / 1M
      outputCostUsd: '0.00800000', // 1000 × 8 / 1M
      cacheSavingsUsd: '0.00060000', // 400 × (2 − 0.5) / 1M
    });
    expect(
      Number(body.inputCostUsd) + Number(body.cachedInputCostUsd) + Number(body.outputCostUsd),
    ).toBeCloseTo(Number(body.estimatedCostUsd), 10);
    expect(body.topRequests).toHaveLength(10);
    expect(body.series.length).toBeGreaterThan(0);
  });

  it('builds a latency histogram and lists the slowest requests', async () => {
    const { body } = await get('performance').expect(200);
    const total = body.histogram.reduce(
      (sum: number, bin: { requests: number }) => sum + bin.requests,
      0,
    );
    expect(total).toBe(13);
    expect(body.histogram[0]).toEqual({ fromMs: 0, toMs: 250, requests: 3 }); // 50, 100, 200
    expect(body.slowest[0]).toMatchObject({
      durationMs: 5000,
      model: 'other-model',
      status: 'error',
    });
  });

  it('lists errors with type filters and cursor pagination', async () => {
    const first = await get('errors', { limit: '1' }).expect(200);
    expect(first.body.byType).toEqual(
      expect.arrayContaining([
        { type: 'timeout', count: 1 },
        { type: 'rate_limit', count: 1 },
      ]),
    );
    expect(first.body.items).toHaveLength(1);
    expect(first.body.items[0]).toMatchObject({
      type: 'rate_limit',
      traceName: 'support',
      spanName: 'answer',
    });

    const second = await get('errors', { limit: '1', cursor: first.body.nextCursor }).expect(200);
    expect(second.body.items[0].type).toBe('timeout');
    expect(second.body.nextCursor).toBeNull();

    const filtered = await get('errors', { type: 'timeout' }).expect(200);
    expect(filtered.body.items.map((item: { type: string }) => item.type)).toEqual(['timeout']);
  });

  it('lists the dimensions available for filters', async () => {
    const { body } = await request(app.getHttpServer())
      .get(`/v1/projects/${projectId}/analytics/dimensions`)
      .set(bearer(token))
      .expect(200);
    // Enum declaration order: development, staging, production.
    expect(body.environments).toEqual(['staging', 'production']);
    expect(body.providers).toEqual(['anthropic', 'openai']);
    expect(body.models).toContainEqual({ provider: 'openai', model: 'mystery-model' });
  });

  it('validates queries', async () => {
    await get('overview', { from: 'yesterday' }).expect(400);
    await get('overview', { from: at(10), to: at(0) }).expect(400);
    await get('overview', { from: '2020-01-01T00:00:00Z', to: '2026-01-01T00:00:00Z' }).expect(400);
    await get('overview', { tz: 'Mars/Olympus' }).expect(400);
  });

  it('isolates tenants', async () => {
    const outsider = await registerUser(app);
    await request(app.getHttpServer())
      .get(`/v1/projects/${projectId}/analytics/overview`)
      .query({ from: at(0), to: at(60) })
      .set(bearer(outsider.accessToken))
      .expect(404);
  });

  it('exposes the price registry', async () => {
    const { body } = await request(app.getHttpServer())
      .get('/v1/pricing')
      .set(bearer(token))
      .expect(200);
    expect(body).toContainEqual(
      expect.objectContaining({
        provider: 'openai',
        model: 'priced-model',
        effectiveFrom: null,
        inputPricePerMillion: '2.000000',
      }),
    );
  });
});
