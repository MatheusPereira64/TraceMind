import { chunkEvents, sendBatch, TraceMindHttpError } from './transport.js';
import type {
  Environment,
  ErrorInfo,
  ErrorType,
  EvaluationEvent,
  IngestEvent,
  SpanEvent,
  SpanKind,
  Status,
  TraceEvent,
  Usage,
} from './types.js';

export const SDK_VERSION = '0.1.0';

/** Minimal view of Node's `process`, so the SDK also runs (and type-checks) in browsers and edge runtimes. */
interface ProcessLike {
  env?: Record<string, string | undefined>;
  once?: (event: string, listener: () => void) => unknown;
  off?: (event: string, listener: () => void) => unknown;
}
const runtimeProcess = (): ProcessLike | undefined =>
  (globalThis as { process?: ProcessLike }).process;

export interface TraceMindOptions {
  /** Project API key (`tm_...`). Defaults to process.env.TRACEMIND_API_KEY. */
  apiKey?: string;
  /** TraceMind API URL. Defaults to process.env.TRACEMIND_URL or http://localhost:4000. */
  baseUrl?: string;
  /** Overrides the API key's default environment for every trace. */
  environment?: Environment;
  /** Send when this many events are buffered. Default 50. */
  flushAt?: number;
  /** Send buffered events at least this often. Default 1000 ms. */
  flushIntervalMs?: number;
  /** Oldest events are dropped beyond this buffer size (never blocks the app). Default 10 000. */
  maxQueueSize?: number;
  maxRetries?: number;
  timeoutMs?: number;
  /** Disable to turn every call into a no-op (e.g. in unit tests). Default true. */
  enabled?: boolean;
  /** Flush automatically before a Node.js process exits. Default true. */
  flushOnExit?: boolean;
  /** Receives delivery problems. Defaults to console.warn; telemetry never throws into app code. */
  onError?: (error: Error) => void;
  /** Custom fetch implementation (proxies, tests). */
  fetch?: typeof fetch;
}

export interface TraceParams {
  name: string;
  id?: string;
  userId?: string;
  sessionId?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  input?: unknown;
  environment?: Environment;
}

export interface SpanParams {
  name: string;
  id?: string;
  kind?: SpanKind;
  provider?: string;
  model?: string;
  input?: unknown;
  modelParameters?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface SpanUpdate {
  output?: unknown;
  usage?: Usage;
  model?: string;
  metadata?: Record<string, unknown>;
  status?: Status;
}

export interface ScoreParams {
  criterion: string;
  /** thumbs: 1 = up, 0 = down. */
  kind: EvaluationEvent['kind'];
  score?: number;
  label?: string;
  comment?: string;
  /** Idempotency key: resubmitting with the same id updates the evaluation. */
  id?: string;
}

function newId(): string {
  const crypto = globalThis.crypto as Crypto | undefined;
  if (crypto?.randomUUID) return crypto.randomUUID();
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
}

const now = () => new Date().toISOString();

/** Converts anything thrown into the wire error shape, classifying common provider failures. */
export function toErrorInfo(error: unknown, type?: ErrorType): ErrorInfo {
  const candidate = error as {
    message?: unknown;
    status?: unknown;
    code?: unknown;
    name?: unknown;
    stack?: unknown;
  };
  const message =
    typeof candidate?.message === 'string' && candidate.message
      ? candidate.message
      : String(error ?? 'Unknown error');
  const status = typeof candidate?.status === 'number' ? candidate.status : undefined;
  const name = typeof candidate?.name === 'string' ? candidate.name : '';
  const code = typeof candidate?.code === 'string' ? candidate.code : undefined;

  const inferred: ErrorType =
    type ??
    (status === 429 || /rate.?limit/i.test(message)
      ? 'rate_limit'
      : /timeout|timed out/i.test(`${name} ${message}`) || code === 'ETIMEDOUT'
        ? 'timeout'
        : status !== undefined && status >= 500
          ? 'provider_error'
          : status !== undefined && status >= 400
            ? 'api_failure'
            : 'unknown');

  return {
    type: inferred,
    message: message.slice(0, 10_000),
    ...(code ? { code: code.slice(0, 200) } : {}),
    ...(status !== undefined && status >= 100 && status <= 599 ? { httpStatus: status } : {}),
    ...(typeof candidate?.stack === 'string' ? { stack: candidate.stack.slice(0, 50_000) } : {}),
  };
}

/** Shared base for traces and spans: both can parent child spans and receive evaluations. */
abstract class Observation {
  protected ended = false;

  constructor(
    protected readonly client: TraceMind,
    readonly id: string,
    readonly traceId: string,
  ) {}

  /** Starts a child span. */
  span(params: SpanParams): Span {
    return new Span(this.client, this.traceId, this.parentIdForChildren(), params);
  }

  /**
   * Runs `fn` inside a child span, ending it with the result or the thrown error.
   * The error is re-thrown, so application behaviour is unchanged.
   */
  async withSpan<T>(params: SpanParams, fn: (span: Span) => Promise<T> | T): Promise<T> {
    const span = this.span(params);
    try {
      const result = await fn(span);
      if (!span.isEnded) span.end({ output: result });
      return result;
    } catch (error) {
      if (!span.isEnded) span.fail(error);
      throw error;
    }
  }

  score(params: ScoreParams): void {
    this.client.enqueue({
      type: 'evaluation',
      traceId: this.traceId,
      ...(this.spanIdForScores() ? { spanId: this.spanIdForScores()! } : {}),
      ...params,
    });
  }

  get isEnded(): boolean {
    return this.ended;
  }

  protected abstract parentIdForChildren(): string | undefined;
  protected abstract spanIdForScores(): string | undefined;
}

export class Trace extends Observation {
  constructor(client: TraceMind, params: TraceParams, environment: Environment | undefined) {
    const id = params.id ?? newId();
    super(client, id, id);
    const event: TraceEvent = {
      type: 'trace',
      id,
      name: params.name,
      startTime: now(),
      ...((params.environment ?? environment)
        ? { environment: params.environment ?? environment }
        : {}),
      ...(params.userId ? { userId: params.userId } : {}),
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      ...(params.tags ? { tags: params.tags } : {}),
      ...(params.metadata ? { metadata: params.metadata } : {}),
      ...(params.input !== undefined ? { input: params.input } : {}),
    };
    client.enqueue(event);
  }

  update(params: Omit<Partial<TraceEvent>, 'type' | 'id'>): void {
    this.client.enqueue({ type: 'trace', id: this.id, ...params });
  }

  /** Marks the trace finished. Returns a resolved promise so `await trace.end()` reads naturally. */
  end(
    params: { output?: unknown; metadata?: Record<string, unknown>; status?: Status } = {},
  ): Promise<void> {
    if (!this.ended) {
      this.ended = true;
      this.client.enqueue({ type: 'trace', id: this.id, endTime: now(), ...params });
    }
    return Promise.resolve();
  }

  /** Ends the trace as failed, recording the error. */
  fail(error: unknown, type?: ErrorType): Promise<void> {
    if (!this.ended) {
      this.ended = true;
      this.client.enqueue({
        type: 'trace',
        id: this.id,
        endTime: now(),
        status: 'error',
        error: toErrorInfo(error, type),
      });
    }
    return Promise.resolve();
  }

  protected parentIdForChildren(): undefined {
    return undefined;
  }

  protected spanIdForScores(): undefined {
    return undefined;
  }
}

export class Span extends Observation {
  readonly parentId: string | undefined;

  constructor(
    client: TraceMind,
    traceId: string,
    parentId: string | undefined,
    params: SpanParams,
  ) {
    super(client, params.id ?? newId(), traceId);
    this.parentId = parentId;
    const event: SpanEvent = {
      type: 'span',
      id: this.id,
      traceId,
      name: params.name,
      startTime: now(),
      ...(parentId ? { parentId } : {}),
      ...(params.kind ? { kind: params.kind } : {}),
      ...(params.provider ? { provider: params.provider } : {}),
      ...(params.model ? { model: params.model } : {}),
      ...(params.input !== undefined ? { input: params.input } : {}),
      ...(params.modelParameters ? { modelParameters: params.modelParameters } : {}),
      ...(params.metadata ? { metadata: params.metadata } : {}),
    };
    client.enqueue(event);
  }

  /** Records intermediate data (e.g. output of a streaming call) without ending the span. */
  update(update: SpanUpdate): void {
    this.client.enqueue({ type: 'span', id: this.id, traceId: this.traceId, ...update });
  }

  end(update: SpanUpdate = {}): Promise<void> {
    if (!this.ended) {
      this.ended = true;
      this.client.enqueue({
        type: 'span',
        id: this.id,
        traceId: this.traceId,
        endTime: now(),
        ...update,
      });
    }
    return Promise.resolve();
  }

  /** Ends the span as failed. */
  fail(error: unknown, type?: ErrorType, update: SpanUpdate = {}): Promise<void> {
    if (!this.ended) {
      this.ended = true;
      this.client.enqueue({
        type: 'span',
        id: this.id,
        traceId: this.traceId,
        endTime: now(),
        status: 'error',
        error: toErrorInfo(error, type),
        ...update,
      });
    }
    return Promise.resolve();
  }

  protected parentIdForChildren(): string {
    return this.id;
  }

  protected spanIdForScores(): string {
    return this.id;
  }
}

/**
 * TraceMind client. Buffers events in memory and sends them in the background; instrumentation
 * calls never block on the network and never throw into application code.
 *
 * Call `await client.shutdown()` before a short-lived process (script, serverless handler) exits.
 */
export class TraceMind {
  private readonly options: Required<Omit<TraceMindOptions, 'apiKey' | 'environment'>> & {
    apiKey: string;
    environment: Environment | undefined;
  };
  private queue: IngestEvent[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<void> = Promise.resolve();
  private dropped = 0;
  private closed = false;
  private readonly exitHandler = () => void this.flush();

  constructor(options: TraceMindOptions = {}) {
    const env = runtimeProcess()?.env ?? {};
    const apiKey = options.apiKey ?? env.TRACEMIND_API_KEY ?? '';
    const enabled = (options.enabled ?? true) && apiKey.length > 0;

    this.options = {
      apiKey,
      baseUrl: options.baseUrl ?? env.TRACEMIND_URL ?? 'http://localhost:4000',
      environment: options.environment,
      flushAt: Math.max(1, options.flushAt ?? 50),
      flushIntervalMs: Math.max(10, options.flushIntervalMs ?? 1_000),
      maxQueueSize: Math.max(1, options.maxQueueSize ?? 10_000),
      maxRetries: Math.max(0, options.maxRetries ?? 5),
      timeoutMs: options.timeoutMs ?? 10_000,
      enabled,
      flushOnExit: options.flushOnExit ?? true,
      onError: options.onError ?? ((error) => console.warn(`[tracemind] ${error.message}`)),
      fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
    };

    if (!enabled && (options.enabled ?? true)) {
      this.options.onError(
        new Error('No API key configured (TRACEMIND_API_KEY); telemetry is disabled'),
      );
    }

    if (enabled) {
      this.timer = setInterval(() => void this.flush(), this.options.flushIntervalMs);
      (this.timer as { unref?: () => void }).unref?.();
      if (this.options.flushOnExit) runtimeProcess()?.once?.('beforeExit', this.exitHandler);
    }
  }

  get enabled(): boolean {
    return this.options.enabled && !this.closed;
  }

  /** Number of buffered, not yet sent events. */
  get pending(): number {
    return this.queue.length;
  }

  trace(params: TraceParams): Trace {
    return new Trace(this, params, this.options.environment);
  }

  /** Records an evaluation for a trace created elsewhere (e.g. user feedback arriving later). */
  score(traceId: string, params: ScoreParams & { spanId?: string }): void {
    this.enqueue({ type: 'evaluation', traceId, ...params });
  }

  /** @internal Used by Trace and Span. */
  enqueue(event: IngestEvent): void {
    if (!this.enabled) return;
    this.queue.push(event);
    if (this.queue.length > this.options.maxQueueSize) {
      const overflow = this.queue.length - this.options.maxQueueSize;
      this.queue.splice(0, overflow);
      this.dropped += overflow;
    }
    if (this.queue.length >= this.options.flushAt) void this.flush();
  }

  /** Sends everything buffered so far. Resolves when delivery has finished or definitively failed. */
  flush(): Promise<void> {
    // Serialize flushes so events are delivered in order and never sent twice concurrently.
    this.inFlight = this.inFlight.then(() => this.drain());
    return this.inFlight;
  }

  /** Flushes and stops the background timer. Further events are ignored. */
  async shutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    runtimeProcess()?.off?.('beforeExit', this.exitHandler);
    await this.flush();
    this.closed = true;
  }

  private async drain(): Promise<void> {
    if (this.dropped > 0) {
      this.options.onError(new Error(`Buffer full: dropped ${this.dropped} oldest events`));
      this.dropped = 0;
    }
    while (this.queue.length > 0) {
      const events = this.queue;
      this.queue = [];
      for (const chunk of chunkEvents(events)) {
        try {
          const result = await sendBatch(chunk, {
            apiKey: this.options.apiKey,
            baseUrl: this.options.baseUrl,
            maxRetries: this.options.maxRetries,
            timeoutMs: this.options.timeoutMs,
            fetch: this.options.fetch,
            sdkVersion: SDK_VERSION,
          });
          if (result.rejected.length > 0) {
            const first = result.rejected[0]!;
            const detail = first.issues
              .map((issue) => `${issue.path}: ${issue.message}`)
              .join('; ');
            this.options.onError(
              new Error(
                `${result.rejected.length} event(s) rejected by TraceMind (first: #${first.index} ${detail})`,
              ),
            );
          }
        } catch (error) {
          const message =
            error instanceof TraceMindHttpError && error.status === 401
              ? 'Invalid, revoked or expired API key; events dropped'
              : `Failed to send ${chunk.length} event(s): ${error instanceof Error ? error.message : String(error)}`;
          this.options.onError(new Error(message));
        }
      }
    }
  }
}
