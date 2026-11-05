import { describe, expect, it, vi } from 'vitest';
import { TraceMind, toErrorInfo } from '../src/index.js';
import { chunkEvents, sendBatch, MAX_EVENTS_PER_REQUEST } from '../src/transport.js';
import { accepted, fakeFetch } from './helpers.js';

const KEY = `tm_dev_${'a'.repeat(32)}`;

function client(fetch: typeof globalThis.fetch, overrides = {}) {
  return new TraceMind({
    apiKey: KEY,
    baseUrl: 'http://tracemind.test/',
    fetch,
    flushAt: 1000,
    flushIntervalMs: 60_000,
    flushOnExit: false,
    maxRetries: 0,
    onError: () => {},
    ...overrides,
  });
}

describe('TraceMind client', () => {
  it('records traces and nested spans with the documented API', async () => {
    const http = fakeFetch();
    const tm = client(http.fetch);

    const trace = tm.trace({ name: 'customer-support', userId: 'user-123', input: 'hi' });
    const span = trace.span({ name: 'generate-response', model: 'gpt-4.1', provider: 'openai' });
    const tool = span.span({ name: 'lookup-order', kind: 'tool', input: { orderId: 7 } });
    await tool.end({ output: { status: 'shipped' } });
    await span.end({ output: 'It shipped', usage: { inputTokens: 10, outputTokens: 4 } });
    await trace.end({ output: 'It shipped' });
    await tm.shutdown();

    expect(http.requests).toHaveLength(1);
    expect(http.requests[0]!.url).toBe('http://tracemind.test/v1/ingest/batch');
    expect(http.requests[0]!.headers.authorization).toBe(`Bearer ${KEY}`);

    const events = http.events();
    expect(events.map((event) => event.type)).toEqual([
      'trace',
      'span',
      'span',
      'span',
      'span',
      'trace',
    ]);
    expect(events[1]).toMatchObject({
      traceId: trace.id,
      name: 'generate-response',
      model: 'gpt-4.1',
      provider: 'openai',
    });
    expect(events[1]).not.toHaveProperty('parentId');
    expect(events[2]).toMatchObject({ parentId: span.id, kind: 'tool' });
    expect(events[4]).toMatchObject({
      id: span.id,
      usage: { inputTokens: 10, outputTokens: 4 },
      endTime: expect.any(String),
    });
    expect(events[5]).toMatchObject({ id: trace.id, output: 'It shipped' });
  });

  it('ends a span only once', async () => {
    const http = fakeFetch();
    const tm = client(http.fetch);
    const span = tm.trace({ name: 't' }).span({ name: 's' });
    await span.end();
    await span.end({ output: 'ignored' });
    await span.fail(new Error('ignored'));
    await tm.flush();
    expect(http.events().filter((event) => event.type === 'span')).toHaveLength(2);
  });

  it('withSpan records results and failures and re-throws', async () => {
    const http = fakeFetch();
    const tm = client(http.fetch);
    const trace = tm.trace({ name: 't' });

    await expect(trace.withSpan({ name: 'ok' }, async () => 42)).resolves.toBe(42);
    await expect(
      trace.withSpan({ name: 'boom' }, async () => {
        throw Object.assign(new Error('Rate limit exceeded'), { status: 429 });
      }),
    ).rejects.toThrow('Rate limit exceeded');
    await tm.flush();

    const ends = http
      .events()
      .filter((event) => event.type === 'span' && 'endTime' in event && event.endTime);
    expect(ends[0]).toMatchObject({ output: 42 });
    expect(ends[1]).toMatchObject({
      status: 'error',
      error: { type: 'rate_limit', httpStatus: 429 },
    });
  });

  it('flushes automatically when flushAt is reached', async () => {
    const http = fakeFetch();
    const tm = client(http.fetch, { flushAt: 3 });
    tm.trace({ name: 'a' });
    tm.trace({ name: 'b' });
    expect(http.requests).toHaveLength(0);
    tm.trace({ name: 'c' });
    await vi.waitFor(() => expect(http.requests).toHaveLength(1));
    await tm.shutdown();
  });

  it('flushes on the interval', async () => {
    vi.useFakeTimers();
    try {
      const http = fakeFetch();
      const tm = client(http.fetch, { flushIntervalMs: 500 });
      tm.trace({ name: 'a' });
      await vi.advanceTimersByTimeAsync(600);
      expect(http.requests).toHaveLength(1);
      await tm.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it('records evaluations on traces, spans and by trace id', async () => {
    const http = fakeFetch();
    const tm = client(http.fetch);
    const trace = tm.trace({ name: 't' });
    const span = trace.span({ name: 's' });
    trace.score({ criterion: 'user_feedback', kind: 'thumbs', score: 1 });
    span.score({ criterion: 'accuracy', kind: 'numeric', score: 0.9, id: 'eval-1' });
    tm.score('external-trace', { criterion: 'tone', kind: 'categorical', label: 'polite' });
    await tm.flush();

    const evaluations = http.events().filter((event) => event.type === 'evaluation');
    expect(evaluations).toEqual([
      {
        type: 'evaluation',
        traceId: trace.id,
        criterion: 'user_feedback',
        kind: 'thumbs',
        score: 1,
      },
      {
        type: 'evaluation',
        traceId: trace.id,
        spanId: span.id,
        criterion: 'accuracy',
        kind: 'numeric',
        score: 0.9,
        id: 'eval-1',
      },
      {
        type: 'evaluation',
        traceId: 'external-trace',
        criterion: 'tone',
        kind: 'categorical',
        label: 'polite',
      },
    ]);
  });

  it('is a silent no-op without an API key', async () => {
    const http = fakeFetch();
    const onError = vi.fn();
    const tm = new TraceMind({ apiKey: '', fetch: http.fetch, onError, flushOnExit: false });
    expect(tm.enabled).toBe(false);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/No API key/) }),
    );
    await tm.trace({ name: 't' }).end();
    await tm.shutdown();
    expect(http.requests).toHaveLength(0);
  });

  it('drops the oldest events when the buffer is full and reports it', async () => {
    const http = fakeFetch();
    const onError = vi.fn();
    const tm = client(http.fetch, { maxQueueSize: 2, onError });
    tm.trace({ name: '1' });
    tm.trace({ name: '2' });
    tm.trace({ name: '3' });
    await tm.flush();
    expect(http.events().map((event) => (event as { name?: string }).name)).toEqual(['2', '3']);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/dropped 1/) }),
    );
  });

  it('reports rejected events without throwing', async () => {
    const onError = vi.fn();
    const http = fakeFetch(
      () =>
        new Response(
          JSON.stringify({
            batchId: '1',
            accepted: 0,
            rejected: [{ index: 0, issues: [{ path: 'name', message: 'Too long' }] }],
          }),
          { status: 202 },
        ),
    );
    const tm = client(http.fetch, { onError });
    tm.trace({ name: 'x' });
    await tm.flush();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringMatching(/1 event\(s\) rejected.*name: Too long/),
      }),
    );
  });

  it('never throws into application code when delivery fails', async () => {
    const onError = vi.fn();
    const tm = client(
      (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
      { onError },
    );
    tm.trace({ name: 'x' });
    await expect(tm.flush()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/fetch failed/) }),
    );
  });

  it('ignores events after shutdown', async () => {
    const http = fakeFetch();
    const tm = client(http.fetch);
    await tm.shutdown();
    tm.trace({ name: 'late' });
    await tm.flush();
    expect(http.requests).toHaveLength(0);
  });
});

describe('transport', () => {
  const options = (fetch: typeof globalThis.fetch, sleep = vi.fn(async (_ms: number) => {})) => ({
    apiKey: KEY,
    baseUrl: 'http://tracemind.test',
    maxRetries: 3,
    timeoutMs: 1000,
    fetch,
    sdkVersion: 'test',
    sleep,
  });

  it('retries 5xx, 429 and network errors with backoff, honouring Retry-After', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const http = fakeFetch((request, attempt) => {
      if (attempt === 1) return new Response('down', { status: 503 });
      if (attempt === 2)
        return new Response('slow down', { status: 429, headers: { 'retry-after': '2' } });
      if (attempt === 3) throw new TypeError('socket hang up');
      return accepted(request.events.length);
    });

    const result = await sendBatch([{ type: 'trace', id: 't' }], options(http.fetch, sleep));
    expect(result.accepted).toBe(1);
    expect(http.requests).toHaveLength(4);
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls[1]![0]).toBe(2000);
  });

  it('does not retry client errors', async () => {
    const http = fakeFetch(() => new Response('{"message":"Invalid API key"}', { status: 401 }));
    await expect(
      sendBatch([{ type: 'trace', id: 't' }], options(http.fetch)),
    ).rejects.toMatchObject({ status: 401 });
    expect(http.requests).toHaveLength(1);
  });

  it('gives up after maxRetries', async () => {
    const http = fakeFetch(() => new Response('down', { status: 500 }));
    await expect(
      sendBatch([{ type: 'trace', id: 't' }], options(http.fetch)),
    ).rejects.toMatchObject({ status: 500 });
    expect(http.requests).toHaveLength(4);
  });

  it('chunks by count and payload size', () => {
    const many = Array.from({ length: MAX_EVENTS_PER_REQUEST * 2 + 1 }, (_, i) => ({
      type: 'trace' as const,
      id: `t${i}`,
    }));
    expect(chunkEvents(many).map((chunk) => chunk.length)).toEqual([500, 500, 1]);

    const big = Array.from({ length: 5 }, (_, i) => ({
      type: 'trace' as const,
      id: `b${i}`,
      input: 'x'.repeat(1_500_000),
    }));
    const chunks = chunkEvents(big);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => JSON.stringify(chunk).length <= 4.5 * 1024 * 1024)).toBe(true);
  });
});

describe('toErrorInfo', () => {
  it.each([
    [Object.assign(new Error('Too many'), { status: 429 }), 'rate_limit'],
    [
      Object.assign(new Error('Request timed out'), { name: 'APIConnectionTimeoutError' }),
      'timeout',
    ],
    [Object.assign(new Error('Server error'), { status: 502 }), 'provider_error'],
    [Object.assign(new Error('Bad request'), { status: 400 }), 'api_failure'],
    [new Error('boom'), 'unknown'],
    ['a string', 'unknown'],
  ])('classifies %s', (error, type) => {
    expect(toErrorInfo(error).type).toBe(type);
  });

  it('respects an explicit type', () => {
    expect(toErrorInfo(new Error('x'), 'tool_call_failed').type).toBe('tool_call_failed');
  });
});
