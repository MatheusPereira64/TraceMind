# @tracemind/sdk

TypeScript SDK for [TraceMind](../../README.md): record LLM calls, tool calls and whole agent runs as
traces, with token usage, cost, latency, errors and quality feedback.

- Zero runtime dependencies; works in Node.js 18+, edge runtimes and browsers (`fetch` + `crypto.randomUUID`).
- Never blocks or throws into your code: events are buffered and sent in the background, with
  retries for network errors, `429` and `5xx` (honouring `Retry-After`).
- Idempotent delivery: the API upserts by id, so retries and duplicates are harmless.

## Quick start

```ts
import { TraceMind } from '@tracemind/sdk';

const tracemind = new TraceMind({
  apiKey: process.env.TRACEMIND_API_KEY, // tm_dev_… / tm_stg_… / tm_prod_…
  baseUrl: process.env.TRACEMIND_URL, // e.g. http://localhost:4000
});

const trace = tracemind.trace({ name: 'customer-support', userId: 'user-123', input: question });

const span = trace.span({
  name: 'generate-response',
  kind: 'llm',
  provider: 'openai',
  model: 'gpt-4.1',
  input: messages,
});
// … call the model …
await span.end({ output: completion, usage: { inputTokens: 812, outputTokens: 96 } });

await trace.end({ output: answer });
await tracemind.shutdown(); // flush before a short-lived process exits
```

### Nested work and errors

```ts
const order = await trace.withSpan({ name: 'lookup-order', kind: 'tool', input: { orderId } }, () =>
  orders.find(orderId),
); // ends the span with the result, or records the error and re-throws it

const retrieval = trace.span({ name: 'search-docs', kind: 'retrieval' });
const rerank = retrieval.span({ name: 'rerank' }); // child of retrieval
try {
  await rerank.end({ output: await rerankDocs(docs) });
} catch (error) {
  await rerank.fail(error); // classifies rate limits, timeouts and HTTP failures
}
await retrieval.end();
```

### OpenAI

```ts
import OpenAI from 'openai';
import { observeOpenAI } from '@tracemind/sdk';

const openai = observeOpenAI(new OpenAI(), { tracemind });
await openai.chat.completions.create({ model: 'gpt-4.1', messages }); // one trace per call

// Or nest calls inside an existing trace/span:
const agentOpenAI = observeOpenAI(new OpenAI(), { tracemind, parent: trace, name: 'plan' });
```

Captures messages, model parameters, the resolved model, output, token usage (including cached
prompt tokens) and errors. Streaming responses (`stream: true`) pass through unchanged while content
and usage are accumulated; request usage in streams with `stream_options: { include_usage: true }`.

### Feedback and evaluations

```ts
trace.score({ criterion: 'user_feedback', kind: 'thumbs', score: 1 });
span.score({ criterion: 'faithfulness', kind: 'numeric', score: 0.82 });
tracemind.score(traceId, {
  criterion: 'tone',
  kind: 'categorical',
  label: 'polite',
  id: 'review-42',
});
```

Passing `id` makes an evaluation idempotent: resubmitting updates it instead of creating another.

## Options

| Option                        | Default                                    |                                                                                 |
| ----------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------- |
| `apiKey`                      | `TRACEMIND_API_KEY`                        | Without a key the client is a silent no-op.                                     |
| `baseUrl`                     | `TRACEMIND_URL` or `http://localhost:4000` |                                                                                 |
| `environment`                 | key's environment                          | Override per client or per trace.                                               |
| `flushAt` / `flushIntervalMs` | `50` / `1000`                              | Send when either is reached.                                                    |
| `maxQueueSize`                | `10000`                                    | Oldest events are dropped beyond this (reported via `onError`).                 |
| `maxRetries` / `timeoutMs`    | `5` / `10000`                              |                                                                                 |
| `onError`                     | `console.warn`                             | Delivery problems and rejected events.                                          |
| `enabled`                     | `true`                                     | Set `false` in unit tests.                                                      |
| `flushOnExit`                 | `true`                                     | Flushes on Node's `beforeExit`; still call `shutdown()` in serverless handlers. |

## Data handling

Prompts and completions are masked by TraceMind **before** they are queued or stored (API keys,
tokens, card numbers, emails and custom terms, configurable per project). The SDK itself sends what
you give it, so avoid passing secrets you would not want masked as `[REDACTED]`.
