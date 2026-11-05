import { describe, expect, it } from 'vitest';
import { TraceMind, observeOpenAI } from '../src/index.js';
import { fakeFetch } from './helpers.js';

const KEY = `tm_dev_${'a'.repeat(32)}`;
const tracemind = (fetch: typeof globalThis.fetch) =>
  new TraceMind({
    apiKey: KEY,
    fetch,
    flushAt: 1000,
    flushIntervalMs: 60_000,
    flushOnExit: false,
    onError: () => {},
  });

/** Minimal stand-in for the `openai` client surface the wrapper relies on. */
function fakeOpenAI(create: (params: Record<string, unknown>) => Promise<unknown>) {
  return {
    apiKey: 'sk-test',
    models: { list: () => 'untouched' },
    chat: { completions: { create, other: () => 'kept' } },
  };
}

const completion = {
  id: 'chatcmpl-1',
  model: 'gpt-4.1-2025-04-14',
  choices: [{ index: 0, message: { role: 'assistant', content: 'Hello!' }, finish_reason: 'stop' }],
  usage: {
    prompt_tokens: 20,
    completion_tokens: 5,
    total_tokens: 25,
    prompt_tokens_details: { cached_tokens: 8 },
  },
};

describe('observeOpenAI', () => {
  it('records a trace and llm span for each call', async () => {
    const http = fakeFetch();
    const tm = tracemind(http.fetch);
    const openai = observeOpenAI(
      fakeOpenAI(async () => completion),
      { tracemind: tm },
    );

    const messages = [{ role: 'user', content: 'Hi' }];
    const result = await openai.chat.completions.create({
      model: 'gpt-4.1',
      messages,
      temperature: 0.1,
      stream: false,
    });
    expect(result).toBe(completion);
    await tm.flush();

    const events = http.events();
    expect(events[0]).toMatchObject({ type: 'trace', name: 'openai.chat', input: messages });
    expect(events[1]).toMatchObject({
      type: 'span',
      kind: 'llm',
      provider: 'openai',
      model: 'gpt-4.1',
      input: messages,
      modelParameters: { temperature: 0.1 },
    });
    expect(events[2]).toMatchObject({
      type: 'span',
      model: 'gpt-4.1-2025-04-14',
      output: { role: 'assistant', content: 'Hello!' },
      usage: { inputTokens: 20, outputTokens: 5, cachedInputTokens: 8, totalTokens: 25 },
      metadata: { finish_reason: 'stop' },
    });
    expect(events[3]).toMatchObject({
      type: 'trace',
      output: { role: 'assistant', content: 'Hello!' },
    });
  });

  it('nests spans under a given parent instead of creating traces', async () => {
    const http = fakeFetch();
    const tm = tracemind(http.fetch);
    const trace = tm.trace({ name: 'agent' });
    const openai = observeOpenAI(
      fakeOpenAI(async () => completion),
      { tracemind: tm, parent: trace, name: 'plan' },
    );

    await openai.chat.completions.create({ model: 'gpt-4.1', messages: [] });
    await tm.flush();
    const events = http.events();
    expect(events.filter((event) => event.type === 'trace')).toHaveLength(1);
    expect(events[1]).toMatchObject({ type: 'span', traceId: trace.id, name: 'plan' });
  });

  it('records provider errors and re-throws them', async () => {
    const http = fakeFetch();
    const tm = tracemind(http.fetch);
    const failure = Object.assign(new Error('Rate limit reached for requests'), {
      status: 429,
      code: 'rate_limit_exceeded',
    });
    const openai = observeOpenAI(
      fakeOpenAI(async () => Promise.reject(failure)),
      { tracemind: tm },
    );

    await expect(openai.chat.completions.create({ model: 'gpt-4.1', messages: [] })).rejects.toBe(
      failure,
    );
    await tm.flush();
    const spanEnd = http.events().find((event) => event.type === 'span' && 'status' in event);
    expect(spanEnd).toMatchObject({
      status: 'error',
      error: { type: 'rate_limit', httpStatus: 429, code: 'rate_limit_exceeded' },
    });
  });

  it('passes streams through while capturing content and usage', async () => {
    const http = fakeFetch();
    const tm = tracemind(http.fetch);
    async function* chunks() {
      yield { model: 'gpt-4.1', choices: [{ delta: { role: 'assistant', content: 'Hel' } }] };
      yield { model: 'gpt-4.1', choices: [{ delta: { content: 'lo' }, finish_reason: 'stop' }] };
      yield { model: 'gpt-4.1', choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } };
    }
    const stream = Object.assign(chunks(), { controller: 'abort-controller' });
    const openai = observeOpenAI(
      fakeOpenAI(async () => stream),
      { tracemind: tm },
    );

    const result = (await openai.chat.completions.create({
      model: 'gpt-4.1',
      messages: [],
      stream: true,
    })) as AsyncIterable<unknown> & {
      controller: string;
    };
    expect(result.controller).toBe('abort-controller');
    const received: unknown[] = [];
    for await (const chunk of result) received.push(chunk);
    expect(received).toHaveLength(3);

    await tm.flush();
    const spanEnd = http
      .events()
      .find((event) => event.type === 'span' && 'endTime' in event && event.endTime);
    expect(spanEnd).toMatchObject({
      output: { role: 'assistant', content: 'Hello', finish_reason: 'stop' },
      usage: { inputTokens: 3, outputTokens: 2 },
    });
  });

  it('leaves the rest of the client untouched', () => {
    const tm = tracemind(fakeFetch().fetch);
    const original = fakeOpenAI(async () => completion);
    const openai = observeOpenAI(original, { tracemind: tm });
    expect(openai.models.list()).toBe('untouched');
    expect(openai.chat.completions.other()).toBe('kept');
    expect(openai.apiKey).toBe('sk-test');
    expect(observeOpenAI({ notOpenAI: true }, { tracemind: tm })).toEqual({ notOpenAI: true });
  });
});
