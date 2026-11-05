import { ingestEventSchema, type IngestEventInput } from '@tracemind/shared';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { IngestEvent } from '../src/types.js';
import { TraceMind } from '../src/index.js';
import { fakeFetch } from './helpers.js';

/**
 * The SDK keeps its own copy of the wire types (zero dependencies). These tests fail if they drift
 * from the server contract in @tracemind/shared.
 */
describe('SDK ↔ server contract', () => {
  it('SDK events are assignable to the server input type', () => {
    expectTypeOf<IngestEvent>().toExtend<IngestEventInput>();
  });

  it('everything the SDK emits passes server validation', async () => {
    const http = fakeFetch();
    const tm = new TraceMind({
      apiKey: `tm_dev_${'a'.repeat(32)}`,
      fetch: http.fetch,
      flushOnExit: false,
      flushAt: 1000,
    });
    const trace = tm.trace({
      name: 't',
      userId: 'u',
      sessionId: 's',
      tags: ['a'],
      metadata: { k: 1 },
      input: 'x',
      environment: 'staging',
    });
    const span = trace.span({
      name: 's',
      kind: 'llm',
      provider: 'openai',
      model: 'm',
      input: [],
      modelParameters: { temperature: 0 },
    });
    span.update({ output: 'partial' });
    await span.fail(Object.assign(new Error('x'), { status: 500 }), undefined, {
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    trace.score({ criterion: 'c', kind: 'thumbs', score: 1 });
    await trace.end({ output: 'y' });
    await tm.shutdown();

    for (const event of http.events()) {
      const result = ingestEventSchema.safeParse(event);
      expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
    }
  });
});
