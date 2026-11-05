import type { Span, TraceMind, Trace } from './client.js';
import type { Usage } from './types.js';

/**
 * OpenAI instrumentation without a dependency on the `openai` package: the client is wrapped by
 * duck typing, so any SDK version exposing `chat.completions.create` works.
 *
 *   const openai = observeOpenAI(new OpenAI(), { tracemind });
 *   await openai.chat.completions.create({ model: 'gpt-4.1', messages });
 *
 * Every call becomes an `llm` span with messages, model parameters, output, token usage and
 * errors. With `parent`, spans nest under an existing trace or span; otherwise each call gets its
 * own trace.
 */

export interface ObserveOptions {
  tracemind: TraceMind;
  /** Nest generated spans under this trace or span. */
  parent?: Trace | Span;
  /** Name for traces/spans created by the wrapper. Default `openai.chat`. */
  name?: string;
  /** Provider slug recorded on spans; use e.g. `azure.ai.openai` for Azure deployments. */
  provider?: string;
}

interface ChatCompletionUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
}

interface ChatCompletionLike {
  model?: string;
  usage?: ChatCompletionUsage | null;
  choices?: Array<{ message?: unknown; finish_reason?: string | null }>;
}

interface ChatCompletionChunkLike {
  model?: string;
  usage?: ChatCompletionUsage | null;
  choices?: Array<{
    delta?: { content?: string | null; role?: string };
    finish_reason?: string | null;
  }>;
}

const PARAMETER_KEYS = [
  'temperature',
  'top_p',
  'max_tokens',
  'max_completion_tokens',
  'frequency_penalty',
  'presence_penalty',
  'seed',
  'stop',
  'n',
  'response_format',
  'tool_choice',
  'reasoning_effort',
] as const;

export function mapOpenAIUsage(usage: ChatCompletionUsage | null | undefined): Usage | undefined {
  if (!usage) return undefined;
  const inputTokens = usage.prompt_tokens ?? 0;
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    inputTokens,
    outputTokens: usage.completion_tokens ?? 0,
    cachedInputTokens: Math.min(cached, inputTokens),
    ...(usage.total_tokens !== undefined ? { totalTokens: usage.total_tokens } : {}),
  };
}

function modelParameters(params: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of PARAMETER_KEYS) if (params[key] !== undefined) result[key] = params[key];
  if (Array.isArray(params.tools)) result.tools = (params.tools as unknown[]).length;
  return result;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof (value as { [Symbol.asyncIterator]?: unknown })?.[Symbol.asyncIterator] === 'function'
  );
}

/** Wraps a stream so chunks pass through untouched while content and usage are accumulated. */
function observeStream<T extends object>(
  stream: T & AsyncIterable<unknown>,
  span: Span,
  ownedTrace: Trace | undefined,
): T {
  let content = '';
  let role = 'assistant';
  let finishReason: string | null | undefined;
  let usage: ChatCompletionUsage | null | undefined;
  let model: string | undefined;

  const finish = (error?: unknown) => {
    const update = {
      output: { role, content, ...(finishReason ? { finish_reason: finishReason } : {}) },
      ...(model ? { model } : {}),
      ...(mapOpenAIUsage(usage) ? { usage: mapOpenAIUsage(usage)! } : {}),
    };
    if (error) {
      void span.fail(error, undefined, update);
      void ownedTrace?.fail(error);
    } else {
      void span.end(update);
      void ownedTrace?.end({ output: update.output });
    }
  };

  const iterate = async function* () {
    try {
      for await (const chunk of stream) {
        const typed = chunk as ChatCompletionChunkLike;
        model ??= typed.model;
        if (typed.usage) usage = typed.usage;
        const choice = typed.choices?.[0];
        if (choice?.delta?.role) role = choice.delta.role;
        if (choice?.delta?.content) content += choice.delta.content;
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        yield chunk;
      }
      finish();
    } catch (error) {
      finish(error);
      throw error;
    }
  };

  return new Proxy(stream, {
    get(target, property, receiver) {
      if (property === Symbol.asyncIterator) return () => iterate();
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export function observeOpenAI<T extends object>(client: T, options: ObserveOptions): T {
  const name = options.name ?? 'openai.chat';
  const provider = options.provider ?? 'openai';

  const instrumentCreate =
    (create: (...args: unknown[]) => unknown, completions: object) =>
    async (...args: unknown[]) => {
      const params = (args[0] ?? {}) as Record<string, unknown>;
      const ownedTrace = options.parent
        ? undefined
        : options.tracemind.trace({ name, input: params.messages });
      const parent = options.parent ?? ownedTrace!;
      const span = parent.span({
        name,
        kind: 'llm',
        provider,
        ...(typeof params.model === 'string' ? { model: params.model } : {}),
        input: params.messages,
        modelParameters: modelParameters(params),
      });

      let result: unknown;
      try {
        result = await create.apply(completions, args);
      } catch (error) {
        void span.fail(error);
        void ownedTrace?.fail(error);
        throw error;
      }

      if (params.stream === true && isAsyncIterable(result)) {
        return observeStream(result as object & AsyncIterable<unknown>, span, ownedTrace);
      }

      const completion = result as ChatCompletionLike;
      const output =
        completion.choices?.length === 1
          ? completion.choices[0]?.message
          : completion.choices?.map((c) => c.message);
      const usage = mapOpenAIUsage(completion.usage);
      void span.end({
        output,
        ...(completion.model ? { model: completion.model } : {}),
        ...(usage ? { usage } : {}),
        ...(completion.choices?.[0]?.finish_reason
          ? { metadata: { finish_reason: completion.choices[0].finish_reason } }
          : {}),
      });
      void ownedTrace?.end({ output });
      return result;
    };

  const chat = (client as { chat?: { completions?: { create?: unknown } } }).chat;
  const completions = chat?.completions;
  if (!completions || typeof completions.create !== 'function') return client;

  const wrappedCompletions = new Proxy(completions, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property === 'create' && typeof value === 'function') {
        return instrumentCreate(value as (...args: unknown[]) => unknown, target);
      }
      return value;
    },
  });
  const wrappedChat = new Proxy(chat, {
    get(target, property, receiver) {
      return property === 'completions'
        ? wrappedCompletions
        : Reflect.get(target, property, receiver);
    },
  });
  return new Proxy(client, {
    get(target, property, receiver) {
      return property === 'chat' ? wrappedChat : Reflect.get(target, property, receiver);
    },
  });
}
