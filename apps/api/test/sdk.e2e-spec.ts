import type { NestExpressApplication } from '@nestjs/platform-express';
import { observeOpenAI, TraceMind } from '@tracemind/sdk';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { createTestApp, setupProjectWithKey } from './test-app.js';

/**
 * End to end: the published SDK talks HTTP to a real API instance, the worker persists to
 * PostgreSQL, and the stored rows are asserted.
 */
describe('SDK → API → PostgreSQL (e2e)', () => {
  let app: NestExpressApplication;
  let pool: pg.Pool;
  let baseUrl: string;

  beforeAll(async () => {
    app = await createTestApp();
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  });

  afterAll(async () => {
    await pool.end();
    await app.close();
  });

  it('records an agent run with a tool call, an OpenAI-style generation, an error and feedback', async () => {
    const { key, projectId } = await setupProjectWithKey(app, 'staging');
    const errors: Error[] = [];
    const tm = new TraceMind({
      apiKey: key,
      baseUrl,
      flushOnExit: false,
      onError: (error) => errors.push(error),
    });

    const trace = tm.trace({
      name: 'customer-support',
      userId: 'user-123',
      sessionId: 'chat-9',
      input: 'Where is order 7?',
    });

    await trace.withSpan(
      { name: 'lookup-order', kind: 'tool', input: { orderId: 7 } },
      async () => ({ status: 'shipped' }),
    );

    const fakeOpenAI = {
      chat: {
        completions: {
          create: async (_params: unknown) => ({
            model: 'gpt-4.1-2025-04-14',
            choices: [
              {
                message: { role: 'assistant', content: 'Order 7 has shipped.' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 120, completion_tokens: 12, total_tokens: 132 },
          }),
        },
      },
    };
    const openai = observeOpenAI(fakeOpenAI, { tracemind: tm, parent: trace, name: 'answer' });
    await openai.chat.completions.create({
      model: 'gpt-4.1',
      messages: [{ role: 'user', content: 'Where is order 7?' }],
    });

    const failing = trace.span({ name: 'send-email', kind: 'tool' });
    await failing.fail(new Error('SMTP timeout'));

    trace.score({ criterion: 'user_feedback', kind: 'thumbs', score: 1, id: 'feedback-1' });
    await trace.end({ output: 'Order 7 has shipped.' });
    await tm.shutdown();
    expect(errors).toEqual([]);

    await vi.waitFor(
      async () => {
        const { rows: traces } = await pool.query(
          `SELECT name, environment, status, end_user_id, session_id, output, duration_ms IS NOT NULL AS timed
           FROM traces WHERE project_id = $1`,
          [projectId],
        );
        expect(traces).toEqual([
          {
            name: 'customer-support',
            environment: 'staging',
            status: 'success',
            end_user_id: 'user-123',
            session_id: 'chat-9',
            output: 'Order 7 has shipped.',
            timed: true,
          },
        ]);

        const { rows: spans } = await pool.query(
          `SELECT s.name, s.kind, s.status, s.provider_id, s.model, u.input_tokens, u.output_tokens, e.type AS error_type
           FROM spans s
           LEFT JOIN token_usage u ON u.span_id = s.id
           LEFT JOIN errors e ON e.span_id = s.id
           WHERE s.project_id = $1 ORDER BY s.name`,
          [projectId],
        );
        // Spans can start within the same millisecond, so compare by name rather than time.
        expect(spans).toEqual([
          {
            name: 'answer',
            kind: 'llm',
            status: 'success',
            provider_id: 'openai',
            model: 'gpt-4.1-2025-04-14',
            input_tokens: 120,
            output_tokens: 12,
            error_type: null,
          },
          {
            name: 'lookup-order',
            kind: 'tool',
            status: 'success',
            provider_id: null,
            model: null,
            input_tokens: null,
            output_tokens: null,
            error_type: null,
          },
          {
            name: 'send-email',
            kind: 'tool',
            status: 'error',
            provider_id: null,
            model: null,
            input_tokens: null,
            output_tokens: null,
            error_type: 'timeout',
          },
        ]);

        const { rows: evaluations } = await pool.query(
          `SELECT criterion, score FROM evaluations WHERE project_id = $1`,
          [projectId],
        );
        expect(evaluations).toEqual([{ criterion: 'user_feedback', score: 1 }]);
      },
      { timeout: 10_000, interval: 100 },
    );
  });

  it('surfaces an invalid key through onError instead of throwing', async () => {
    const errors: Error[] = [];
    const tm = new TraceMind({
      apiKey: `tm_dev_${'0'.repeat(32)}`,
      baseUrl,
      flushOnExit: false,
      onError: (error) => errors.push(error),
    });
    tm.trace({ name: 'nope' });
    await tm.shutdown();
    expect(errors.map((error) => error.message)).toEqual([
      'Invalid, revoked or expired API key; events dropped',
    ]);
  });
});
