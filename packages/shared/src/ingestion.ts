import { z } from 'zod';
import { ENVIRONMENTS, ERROR_TYPES, EVALUATION_KINDS, SPAN_KINDS } from './enums.js';

/**
 * Telemetry ingestion contract (POST /v1/ingest/batch).
 *
 * Every event is an idempotent upsert keyed by a client-generated id, so SDKs can retry freely and
 * send updates (e.g. a span first when it starts, then again when it ends). Fields omitted from a
 * later event keep their stored value.
 */

export const INGEST_MAX_EVENTS = 1000;
/** Strings longer than this are truncated before persistence. */
export const INGEST_MAX_STRING_LENGTH = 100_000;

/** Run cross-field checks only when field-level validation passed, so errors are not duplicated. */
const onlyIfValid = { when: (payload: { issues: unknown[] }) => payload.issues.length === 0 };

const externalId = z.string().trim().min(1).max(128);
const timestamp = z.iso.datetime({ offset: true });
const metadata = z.record(z.string().max(200), z.unknown());
/** Prompts, completions, tool arguments: any JSON value. */
const payload = z.unknown();

export const usageSchema = z
  .object({
    inputTokens: z.number().int().min(0).max(100_000_000).default(0),
    outputTokens: z.number().int().min(0).max(100_000_000).default(0),
    cachedInputTokens: z.number().int().min(0).max(100_000_000).default(0),
    totalTokens: z.number().int().min(0).max(200_000_000).optional(),
    /** Cost reported by the provider or client. Kept separate from TraceMind's estimate. */
    costUsd: z.number().min(0).max(1_000_000).optional(),
  })
  .refine((usage) => usage.cachedInputTokens <= usage.inputTokens, {
    message: 'cachedInputTokens cannot exceed inputTokens',
    path: ['cachedInputTokens'],
    ...onlyIfValid,
  });
export type UsageInput = z.infer<typeof usageSchema>;

export const errorInfoSchema = z.object({
  type: z.enum(ERROR_TYPES).default('unknown'),
  message: z.string().min(1).max(10_000),
  code: z.string().max(200).optional(),
  httpStatus: z.number().int().min(100).max(599).optional(),
  stack: z.string().max(50_000).optional(),
});
export type ErrorInfoInput = z.infer<typeof errorInfoSchema>;

const endAfterStart = <T extends { startTime?: string | undefined; endTime?: string | undefined }>(
  value: T,
) => !value.startTime || !value.endTime || Date.parse(value.endTime) >= Date.parse(value.startTime);

export const traceEventSchema = z
  .object({
    type: z.literal('trace'),
    id: externalId,
    name: z.string().trim().min(1).max(200).optional(),
    environment: z.enum(ENVIRONMENTS).optional(),
    userId: z.string().max(200).optional(),
    sessionId: z.string().max(200).optional(),
    tags: z.array(z.string().trim().min(1).max(64)).max(32).optional(),
    metadata: metadata.optional(),
    input: payload.optional(),
    output: payload.optional(),
    startTime: timestamp.optional(),
    endTime: timestamp.optional(),
    /** Overrides the status derived from endTime/error. */
    status: z.enum(['running', 'success', 'error']).optional(),
    error: errorInfoSchema.optional(),
  })
  .refine(endAfterStart, {
    message: 'endTime must not be before startTime',
    path: ['endTime'],
    ...onlyIfValid,
  });
export type TraceEvent = z.infer<typeof traceEventSchema>;

export const spanEventSchema = z
  .object({
    type: z.literal('span'),
    id: externalId,
    traceId: externalId,
    parentId: externalId.optional(),
    name: z.string().trim().min(1).max(200).optional(),
    kind: z.enum(SPAN_KINDS).optional(),
    provider: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/)
      .optional(),
    model: z.string().trim().min(1).max(200).optional(),
    input: payload.optional(),
    output: payload.optional(),
    modelParameters: metadata.optional(),
    metadata: metadata.optional(),
    startTime: timestamp.optional(),
    endTime: timestamp.optional(),
    status: z.enum(['running', 'success', 'error']).optional(),
    usage: usageSchema.optional(),
    error: errorInfoSchema.optional(),
  })
  .refine(endAfterStart, {
    message: 'endTime must not be before startTime',
    path: ['endTime'],
    ...onlyIfValid,
  })
  .refine((span) => span.parentId !== span.id, {
    message: 'A span cannot be its own parent',
    path: ['parentId'],
    ...onlyIfValid,
  });
export type SpanEvent = z.infer<typeof spanEventSchema>;

export const evaluationEventSchema = z
  .object({
    type: z.literal('evaluation'),
    /** Optional idempotency key; without it every submission creates a new evaluation. */
    id: externalId.optional(),
    traceId: externalId,
    spanId: externalId.optional(),
    criterion: z.string().trim().min(1).max(100),
    kind: z.enum(EVALUATION_KINDS),
    score: z.number().finite().optional(),
    label: z.string().max(200).optional(),
    comment: z.string().max(5_000).optional(),
  })
  .refine(
    (evaluation) =>
      evaluation.kind !== 'thumbs' || evaluation.score === 0 || evaluation.score === 1,
    {
      message: 'thumbs evaluations need score 0 (down) or 1 (up)',
      path: ['score'],
      ...onlyIfValid,
    },
  )
  .refine((evaluation) => evaluation.kind !== 'numeric' || evaluation.score !== undefined, {
    message: 'numeric evaluations need a score',
    path: ['score'],
    ...onlyIfValid,
  })
  .refine((evaluation) => evaluation.kind !== 'categorical' || evaluation.label !== undefined, {
    message: 'categorical evaluations need a label',
    path: ['label'],
    ...onlyIfValid,
  });
export type EvaluationEvent = z.infer<typeof evaluationEventSchema>;

export const ingestEventSchema = z.discriminatedUnion('type', [
  traceEventSchema,
  spanEventSchema,
  evaluationEventSchema,
]);
export type IngestEvent = z.infer<typeof ingestEventSchema>;
export type IngestEventInput = z.input<typeof ingestEventSchema>;

/**
 * The envelope is validated loosely (events are `unknown`) so one malformed event does not reject
 * the whole batch: each event is validated individually and reported back by index.
 */
export const ingestBatchSchema = z.object({
  events: z.array(z.unknown()).min(1).max(INGEST_MAX_EVENTS),
  sdk: z.object({ name: z.string().max(100), version: z.string().max(50) }).optional(),
});

export interface IngestRejection {
  index: number;
  eventId?: string;
  issues: Array<{ path: string; message: string }>;
}

export interface IngestBatchResponse {
  batchId: string | null;
  accepted: number;
  rejected: IngestRejection[];
}

/* -------------------------------------------------------------- project settings */

export const redactionSettingsSchema = z.object({
  /** Built-in detectors: provider/API keys, bearer tokens, JWTs, private keys, card numbers. */
  enabled: z.boolean(),
  maskEmails: z.boolean(),
  maskPhoneNumbers: z.boolean(),
  /**
   * Exact strings to mask (case-sensitive), e.g. an internal hostname. Literal matching is used
   * instead of user-supplied regular expressions to rule out catastrophic backtracking (ReDoS).
   */
  literals: z.array(z.string().min(3).max(200)).max(50),
});
export type RedactionSettings = z.infer<typeof redactionSettingsSchema>;

export const DEFAULT_REDACTION_SETTINGS: RedactionSettings = {
  enabled: true,
  maskEmails: true,
  maskPhoneNumbers: false,
  literals: [],
};

export interface IngestionStatusDto {
  traceCount: number;
  spanCount: number;
  lastReceivedAt: string | null;
  recentFailures: Array<{ id: number; reason: string; createdAt: string }>;
}
