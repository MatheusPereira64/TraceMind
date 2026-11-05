/**
 * Wire format of POST /v1/ingest/batch. Mirrors the server contract in @tracemind/shared; the SDK
 * keeps its own copy so it has zero runtime dependencies. test/contract.test.ts fails the build if
 * the two drift apart.
 */

export type Environment = 'development' | 'staging' | 'production';
export type Status = 'running' | 'success' | 'error';
export type SpanKind = 'llm' | 'tool' | 'retrieval' | 'chain' | 'embedding' | 'custom';
export type ErrorType =
  | 'provider_error'
  | 'api_failure'
  | 'rate_limit'
  | 'timeout'
  | 'invalid_response'
  | 'tool_call_failed'
  | 'unknown';

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  /** Portion of inputTokens served from the provider's prompt cache. */
  cachedInputTokens?: number;
  totalTokens?: number;
  /** Cost reported by the provider, if known. TraceMind also computes its own estimate. */
  costUsd?: number;
}

export interface ErrorInfo {
  type?: ErrorType;
  message: string;
  code?: string;
  httpStatus?: number;
  stack?: string;
}

export interface TraceEvent {
  type: 'trace';
  id: string;
  name?: string;
  environment?: Environment;
  userId?: string;
  sessionId?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  input?: unknown;
  output?: unknown;
  startTime?: string;
  endTime?: string;
  status?: Status;
  error?: ErrorInfo;
}

export interface SpanEvent {
  type: 'span';
  id: string;
  traceId: string;
  parentId?: string;
  name?: string;
  kind?: SpanKind;
  provider?: string;
  model?: string;
  input?: unknown;
  output?: unknown;
  modelParameters?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  startTime?: string;
  endTime?: string;
  status?: Status;
  usage?: Usage;
  error?: ErrorInfo;
}

export interface EvaluationEvent {
  type: 'evaluation';
  id?: string;
  traceId: string;
  spanId?: string;
  criterion: string;
  kind: 'thumbs' | 'numeric' | 'categorical';
  score?: number;
  label?: string;
  comment?: string;
}

export type IngestEvent = TraceEvent | SpanEvent | EvaluationEvent;

export interface IngestResponse {
  batchId: string | null;
  accepted: number;
  rejected: Array<{
    index: number;
    eventId?: string;
    issues: Array<{ path: string; message: string }>;
  }>;
}
