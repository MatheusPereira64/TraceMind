import type { IngestEvent, IngestResponse } from './types.js';

export interface TransportOptions {
  apiKey: string;
  baseUrl: string;
  maxRetries: number;
  timeoutMs: number;
  fetch: typeof fetch;
  sdkVersion: string;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export class TraceMindHttpError extends Error {
  override readonly name = 'TraceMindHttpError';
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Server limit is 1000 events and 5 MB per request; stay comfortably below both. */
export const MAX_EVENTS_PER_REQUEST = 500;
export const MAX_BYTES_PER_REQUEST = 4 * 1024 * 1024;

function isRetryable(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** Splits events into request-sized chunks by count and serialized size. */
export function chunkEvents(events: IngestEvent[]): IngestEvent[][] {
  const chunks: IngestEvent[][] = [];
  let current: IngestEvent[] = [];
  let bytes = 0;
  for (const event of events) {
    const size = JSON.stringify(event).length;
    if (
      current.length > 0 &&
      (current.length >= MAX_EVENTS_PER_REQUEST || bytes + size > MAX_BYTES_PER_REQUEST)
    ) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(event);
    bytes += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Sends one batch with retries: network errors, timeouts, 408, 429 and 5xx are retried with
 * exponential backoff and jitter (honouring Retry-After); other 4xx responses are not, because
 * resending the same payload cannot succeed. Safe to retry because ingestion is idempotent.
 */
export async function sendBatch(
  events: IngestEvent[],
  options: TransportOptions,
): Promise<IngestResponse> {
  const sleep = options.sleep ?? defaultSleep;
  const url = `${options.baseUrl.replace(/\/$/, '')}/v1/ingest/batch`;
  const body = JSON.stringify({
    events,
    sdk: { name: 'tracemind-js', version: options.sdkVersion },
  });

  let lastError: unknown;
  for (let attempt = 0; attempt <= options.maxRetries; attempt += 1) {
    let delay = Math.min(30_000, 500 * 2 ** attempt) * (0.5 + Math.random() / 2);
    try {
      const response = await options.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${options.apiKey}` },
        body,
        signal: AbortSignal.timeout(options.timeoutMs),
      });

      if (response.ok) return (await response.json()) as IngestResponse;

      const text = await response.text().catch(() => '');
      lastError = new TraceMindHttpError(
        response.status,
        `TraceMind responded ${response.status}: ${text.slice(0, 500)}`,
      );
      if (!isRetryable(response.status)) throw lastError;
      delay = retryAfterMs(response.headers.get('retry-after')) ?? delay;
    } catch (error) {
      if (error instanceof TraceMindHttpError && !isRetryable(error.status)) throw error;
      lastError = error;
    }
    if (attempt < options.maxRetries) await sleep(delay);
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
