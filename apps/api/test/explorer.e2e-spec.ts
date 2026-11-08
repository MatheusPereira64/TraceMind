import type { NestExpressApplication } from '@nestjs/platform-express';
import type {
  EvaluationDto,
  EvaluationSummaryDto,
  GenerationDetailDto,
  GenerationsPage,
  RepeatedPromptDto,
  TraceDetailDto,
  TracesPage,
} from '@tracemind/shared';
import pg from 'pg';
import request from 'supertest';
import { bearer, createTestApp, registerUser, setupProjectWithKey } from './test-app.js';

const BASE = Date.parse('2026-11-03T10:00:00.000Z');
const t = (offsetMs: number) => new Date(BASE + offsetMs).toISOString();
const RANGE = `from=${t(-3_600_000)}&to=${t(86_400_000)}`;

/** One support conversation: agent → classify (llm) + answer (llm), optional failing tool. */
function conversation(
  id: string,
  minute: number,
  question: string,
  options: { fail?: boolean } = {},
) {
  const start = minute * 60_000;
  return [
    {
      type: 'trace',
      id,
      name: 'customer-support',
      userId: `user-${minute}`,
      sessionId: 'session-1',
      input: question,
      output: options.fail ? undefined : 'Answer',
      startTime: t(start),
      endTime: t(start + (options.fail ? 9_000 : 2_000)),
      ...(options.fail ? { status: 'error' } : {}),
    },
    {
      type: 'span',
      id: 'agent',
      traceId: id,
      name: 'support-agent',
      kind: 'chain',
      startTime: t(start),
      endTime: t(start + 1_900),
    },
    {
      type: 'span',
      id: 'classify',
      traceId: id,
      parentId: 'agent',
      name: 'classify-intent',
      provider: 'openai',
      model: 'explorer-model',
      input: [
        { role: 'system', content: 'Classify the intent.' },
        { role: 'user', content: question },
      ],
      output: { role: 'assistant', content: 'shipping' },
      usage: { inputTokens: 100, outputTokens: 2 },
      startTime: t(start + 10),
      endTime: t(start + 210),
    },
    {
      type: 'span',
      id: 'answer',
      traceId: id,
      parentId: 'agent',
      name: 'generate-answer',
      provider: 'openai',
      model: 'explorer-model',
      input: [{ role: 'user', content: question }],
      output: { role: 'assistant', content: `Reply to ${question}` },
      modelParameters: { temperature: 0.3 },
      usage: { inputTokens: 1_000, outputTokens: 200 },
      startTime: t(start + 300),
      endTime: t(start + 1_800),
    },
    ...(options.fail
      ? [
          {
            type: 'span',
            id: 'lookup',
            traceId: id,
            parentId: 'agent',
            name: 'lookup-order',
            kind: 'tool',
            input: { orderId: 42 },
            status: 'error',
            error: { type: 'tool_call_failed', message: 'Order service unavailable' },
            startTime: t(start + 1_850),
            endTime: t(start + 8_900),
          },
        ]
      : []),
  ];
}

describe('Trace Explorer, prompt history and evaluations (e2e)', () => {
  let app: NestExpressApplication;
  let pool: pg.Pool;
  let token: string;
  let projectId: string;
  let organizationId: string;

  const api = () => request(app.getHttpServer());
  const get = <T>(path: string) =>
    api()
      .get(`/v1/projects/${projectId}/${path}`)
      .set(bearer(token))
      .expect(200)
      .then((response) => response.body as T);

  beforeAll(async () => {
    app = await createTestApp();
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    await pool.query(
      `INSERT INTO model_pricing (provider_id, model, input_price_per_million, output_price_per_million, effective_from, source)
       VALUES ('openai', 'explorer-model', 1, 4, '2026-01-01', 'test fixture') ON CONFLICT DO NOTHING`,
    );
    const setup = await setupProjectWithKey(app);
    token = setup.owner.accessToken;
    projectId = setup.projectId;
    organizationId = setup.organizationId;

    const events = [
      ...conversation('conv-1', 0, 'Do you ship to Manaus?'),
      ...conversation('conv-2', 5, 'Do you ship to Manaus?'),
      ...conversation('conv-3', 10, 'Where is my PlayStation order?', { fail: true }),
      ...Array.from({ length: 5 }, (_, index) =>
        conversation(`bulk-${index}`, 20 + index, `Question number ${index}`),
      ).flat(),
    ];
    await api().post('/v1/ingest/batch').set(bearer(setup.key)).send({ events }).expect(202);
    await vi.waitFor(
      async () => {
        const { rows } = await pool.query<{ count: string }>(
          `SELECT count(*) FROM spans WHERE project_id = $1`,
          [projectId],
        );
        expect(Number(rows[0]!.count)).toBe(8 * 3 + 1);
      },
      { timeout: 10_000, interval: 50 },
    );
  });

  afterAll(async () => {
    await pool.end();
    await app.close();
  });

  describe('traces', () => {
    it('lists traces newest first with aggregated tokens, cost, models and errors', async () => {
      const page = await get<TracesPage>(`traces?${RANGE}`);
      expect(page.items.map((item) => item.id)).toEqual([
        'bulk-4',
        'bulk-3',
        'bulk-2',
        'bulk-1',
        'bulk-0',
        'conv-3',
        'conv-2',
        'conv-1',
      ]);
      const failed = page.items.find((item) => item.id === 'conv-3')!;
      expect(failed).toMatchObject({
        status: 'error',
        spanCount: 4,
        llmCalls: 2,
        totalTokens: 1_302,
        // (1100 × $1 + 202 × $4) / 1M
        costUsd: '0.00190800',
        models: ['explorer-model'],
        errorCount: 1,
        endUserId: 'user-10',
      });
      expect(page.nextCursor).toBeNull();
    });

    it('paginates with a keyset cursor without gaps or duplicates', async () => {
      const first = await get<TracesPage>(`traces?${RANGE}&limit=3`);
      expect(first.items).toHaveLength(3);
      const second = await get<TracesPage>(`traces?${RANGE}&limit=3&cursor=${first.nextCursor}`);
      const third = await get<TracesPage>(`traces?${RANGE}&limit=3&cursor=${second.nextCursor}`);
      const ids = [...first.items, ...second.items, ...third.items].map((item) => item.id);
      expect(new Set(ids).size).toBe(8);
      expect(third.nextCursor).toBeNull();
    });

    it('filters by status, duration, user and full-text search over spans', async () => {
      expect(
        (await get<TracesPage>(`traces?${RANGE}&status=error`)).items.map((i) => i.id),
      ).toEqual(['conv-3']);
      expect(
        (await get<TracesPage>(`traces?${RANGE}&minDurationMs=5000`)).items.map((i) => i.id),
      ).toEqual(['conv-3']);
      expect(
        (await get<TracesPage>(`traces?${RANGE}&userId=user-5`)).items.map((i) => i.id),
      ).toEqual(['conv-2']);
      // "PlayStation" only appears in span payloads and the trace input.
      expect(
        (await get<TracesPage>(`traces?${RANGE}&q=playstation`)).items.map((i) => i.id),
      ).toEqual(['conv-3']);
      // Exact id lookup.
      expect((await get<TracesPage>(`traces?${RANGE}&q=bulk-2`)).items.map((i) => i.id)).toContain(
        'bulk-2',
      );
      expect((await get<TracesPage>(`traces?${RANGE}&q=nonexistentword`)).items).toEqual([]);
    });

    it('returns a trace with its span tree, usage, errors and evaluations', async () => {
      const detail = await get<TraceDetailDto>('traces/conv-3');
      expect(detail.trace).toMatchObject({
        id: 'conv-3',
        status: 'error',
        input: 'Where is my PlayStation order?',
        isComplete: true,
      });
      expect(detail.spans.map((span) => [span.id, span.parentId])).toEqual([
        ['agent', null],
        ['classify', 'agent'],
        ['answer', 'agent'],
        ['lookup', 'agent'],
      ]);
      const answer = detail.spans.find((span) => span.id === 'answer')!;
      expect(answer.usage).toMatchObject({
        inputTokens: 1_000,
        outputTokens: 200,
        estimatedCostUsd: '0.00180000',
      });
      expect(answer.modelParameters).toEqual({ temperature: 0.3 });
      expect(detail.spans.find((span) => span.id === 'lookup')!.errors).toEqual([
        expect.objectContaining({ type: 'tool_call_failed', message: 'Order service unavailable' }),
      ]);
      expect(detail.totals).toMatchObject({
        spans: 4,
        llmCalls: 2,
        errors: 1,
        costUsd: '0.00190800',
      });
    });

    it('404s for unknown traces and hides traces from other organizations', async () => {
      await api().get(`/v1/projects/${projectId}/traces/missing`).set(bearer(token)).expect(404);
      const stranger = await registerUser(app);
      await api()
        .get(`/v1/projects/${projectId}/traces/conv-1`)
        .set(bearer(stranger.accessToken))
        .expect(404);
      await api()
        .get(`/v1/projects/${projectId}/traces?${RANGE}&limit=1000`)
        .set(bearer(token))
        .expect(400);
    });
  });

  describe('prompt history', () => {
    it('lists LLM calls with previews and searches them', async () => {
      const page = await get<GenerationsPage>(`generations?${RANGE}&q=manaus`);
      expect(page.items).toHaveLength(4);
      expect(page.items[0]).toMatchObject({
        traceId: 'conv-2',
        spanName: 'generate-answer',
        promptPreview: 'Do you ship to Manaus?',
        responsePreview: 'Reply to Do you ship to Manaus?',
        inputTokens: 1_000,
        costUsd: '0.00180000',
      });
    });

    it('groups identical inputs into repeated prompts and drills into them', async () => {
      const repeated = await get<RepeatedPromptDto[]>(`prompts/repeated?${RANGE}`);
      const manaus = repeated.filter((entry) => entry.promptPreview === 'Do you ship to Manaus?');
      // The classifier and answer prompts differ (system prompt), so they are two groups.
      expect(manaus).toHaveLength(2);
      expect(manaus.every((entry) => entry.calls === 2 && entry.distinctOutputs === 1)).toBe(true);

      const calls = await get<GenerationsPage>(
        `generations?${RANGE}&inputHash=${manaus[0]!.inputHash}`,
      );
      expect(calls.items.map((item) => item.traceId)).toEqual(['conv-2', 'conv-1']);

      const detail = await get<GenerationDetailDto>(`generations/${manaus[0]!.latestUid}`);
      expect(detail).toMatchObject({ traceId: 'conv-2', environment: 'production' });
      expect(detail.span.uid).toBe(manaus[0]!.latestUid);
    });
  });

  describe('evaluations', () => {
    const evaluate = (traceId: string, body: object, auth = token) =>
      api()
        .post(`/v1/projects/${projectId}/traces/${traceId}/evaluations`)
        .set(bearer(auth))
        .send(body);

    it('manages criteria definitions and validates scores against them', async () => {
      const created = await api()
        .post(`/v1/projects/${projectId}/evaluation-criteria`)
        .set(bearer(token))
        .send({ name: 'accuracy', kind: 'numeric', minScore: 1, maxScore: 5 })
        .expect(201);
      await api()
        .post(`/v1/projects/${projectId}/evaluation-criteria`)
        .set(bearer(token))
        .send({ name: 'accuracy', kind: 'numeric', minScore: 1, maxScore: 5 })
        .expect(409);
      await api()
        .put(`/v1/projects/${projectId}/evaluation-criteria/${created.body.id}`)
        .set(bearer(token))
        .send({ name: 'accuracy', kind: 'thumbs' })
        .expect(400);

      await evaluate('conv-1', { criterion: 'accuracy', kind: 'numeric', score: 9 }).expect(400);
      await evaluate('conv-1', { criterion: 'accuracy', kind: 'thumbs', score: 1 }).expect(400);
      await evaluate('conv-1', { criterion: 'accuracy', kind: 'numeric', score: 4 }).expect(201);
    });

    it('updates a user’s own score instead of duplicating it, per trace or span', async () => {
      const first = (
        await evaluate('conv-2', { criterion: 'user_feedback', kind: 'thumbs', score: 1 }).expect(
          201,
        )
      ).body as EvaluationDto;
      const second = (
        await evaluate('conv-2', {
          criterion: 'user_feedback',
          kind: 'thumbs',
          score: 0,
          comment: 'Wrong delivery estimate',
        }).expect(201)
      ).body as EvaluationDto;
      expect(second.id).toBe(first.id);
      expect(second).toMatchObject({
        score: 0,
        source: 'human',
        comment: 'Wrong delivery estimate',
      });
      expect(second.createdBy?.name).toBeTruthy();

      const onSpan = (
        await evaluate('conv-2', {
          criterion: 'user_feedback',
          kind: 'thumbs',
          score: 1,
          spanId: 'answer',
        }).expect(201)
      ).body as EvaluationDto;
      expect(onSpan.id).not.toBe(first.id);
      expect(onSpan.spanId).toBe('answer');

      const detail = await get<TraceDetailDto>('traces/conv-2');
      expect(detail.evaluations).toHaveLength(2);
      await evaluate('conv-2', {
        criterion: 'user_feedback',
        kind: 'thumbs',
        score: 1,
        spanId: 'nope',
      }).expect(404);
    });

    it('summarizes quality per criterion with a gap-filled trend', async () => {
      await evaluate('conv-1', { criterion: 'user_feedback', kind: 'thumbs', score: 1 }).expect(
        201,
      );
      await evaluate('bulk-0', { criterion: 'user_feedback', kind: 'thumbs', score: 1 }).expect(
        201,
      );
      // Bucketed by trace start time: RANGE spans 25 hours, so 25 hourly points.
      const range = RANGE;
      const summary = await get<EvaluationSummaryDto>(`evaluations/summary?${range}`);
      const feedback = summary.criteria.find((entry) => entry.criterion === 'user_feedback')!;
      // conv-2 (0) + conv-2/answer (1) + conv-1 (1) + bulk-0 (1)
      expect(feedback).toMatchObject({
        kind: 'thumbs',
        count: 4,
        positive: 3,
        negative: 1,
        average: 0.75,
      });
      expect(feedback.series).toHaveLength(25);
      expect(feedback.series.reduce((sum, point) => sum + point.count, 0)).toBe(4);
      expect(summary.criteria.find((entry) => entry.criterion === 'accuracy')).toMatchObject({
        count: 1,
        average: 4,
        definition: expect.objectContaining({ minScore: 1, maxScore: 5 }),
      });
      expect(summary.bySource).toEqual([{ source: 'human', count: 5 }]);

      const list = await get<{ items: EvaluationDto[] }>(`evaluations?${range}&criterion=accuracy`);
      expect(list.items).toHaveLength(1);
    });

    it('only lets authors or admins delete evaluations, and viewers cannot score', async () => {
      const member = await registerUser(app);
      await pool.query(
        `INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'viewer')`,
        [organizationId, member.user.id],
      );
      await evaluate(
        'conv-1',
        { criterion: 'user_feedback', kind: 'thumbs', score: 0 },
        member.accessToken,
      ).expect(403);

      const own = (
        await evaluate('bulk-1', { criterion: 'user_feedback', kind: 'thumbs', score: 1 }).expect(
          201,
        )
      ).body as EvaluationDto;
      await api()
        .delete(`/v1/projects/${projectId}/evaluations/${own.id}`)
        .set(bearer(member.accessToken))
        .expect(403);
      await api()
        .delete(`/v1/projects/${projectId}/evaluations/${own.id}`)
        .set(bearer(token))
        .expect(204);
      await api()
        .delete(`/v1/projects/${projectId}/evaluations/${own.id}`)
        .set(bearer(token))
        .expect(404);
    });
  });
});
