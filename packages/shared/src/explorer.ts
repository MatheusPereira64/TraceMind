import { z } from 'zod';
import { analyticsQuerySchema, type BucketSize } from './analytics.js';
import {
  EVALUATION_KINDS,
  EVALUATION_SOURCES,
  TRACE_STATUSES,
  type Environment,
  type ErrorType,
  type EvaluationKind,
  type EvaluationSource,
  type SpanKind,
  type TraceStatus,
} from './enums.js';

/**
 * Trace Explorer, prompt history and evaluation contracts. Trace and span ids in these DTOs are
 * the ids the client sent (external ids); `uid` fields are server ids used for direct links.
 */

const onlyIfValid = { when: (payload: { issues: unknown[] }) => payload.issues.length === 0 };
const pageLimit = z.coerce.number().int().min(1).max(100).default(50);
const cursor = z.string().max(300).optional();
const search = z.string().trim().max(200).optional();

/* -------------------------------------------------------------------- traces */

export const tracesQuerySchema = analyticsQuerySchema.and(
  z.object({
    /** Full-text search over names, inputs and outputs of the trace and its spans, or an exact id. */
    q: search,
    status: z.enum(TRACE_STATUSES).optional(),
    minDurationMs: z.coerce.number().int().min(0).optional(),
    userId: z.string().max(200).optional(),
    sessionId: z.string().max(200).optional(),
    limit: pageLimit,
    cursor,
  }),
);
export type TracesQuery = z.infer<typeof tracesQuerySchema>;

export interface TraceListItem {
  id: string;
  name: string;
  environment: Environment;
  status: TraceStatus;
  startedAt: string;
  durationMs: number | null;
  spanCount: number;
  llmCalls: number;
  totalTokens: number;
  costUsd: string;
  models: string[];
  errorCount: number;
  evaluationCount: number;
  endUserId: string | null;
  sessionId: string | null;
  tags: string[];
  isSimulated: boolean;
}

export interface TracesPage {
  items: TraceListItem[];
  nextCursor: string | null;
}

export interface SpanUsageDto {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
  estimatedCostUsd: string | null;
  reportedCostUsd: string | null;
}

export interface SpanErrorDto {
  type: ErrorType;
  message: string;
  code: string | null;
  httpStatus: number | null;
  occurredAt: string;
}

export interface SpanDto {
  /** Server id: stable link target for prompt history and comparisons. */
  uid: string;
  id: string;
  /** Parent span id, or null for root spans (and spans whose parent never arrived). */
  parentId: string | null;
  name: string;
  kind: SpanKind;
  status: TraceStatus;
  provider: string | null;
  model: string | null;
  input: unknown;
  output: unknown;
  modelParameters: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  usage: SpanUsageDto | null;
  errors: SpanErrorDto[];
}

export interface EvaluationDto {
  id: string;
  traceId: string;
  /** External span id when the evaluation targets a single span. */
  spanId: string | null;
  criterion: string;
  kind: EvaluationKind;
  score: number | null;
  label: string | null;
  comment: string | null;
  source: EvaluationSource;
  createdBy: { id: string; name: string } | null;
  createdAt: string;
}

export interface TraceDetailDto {
  trace: {
    id: string;
    name: string;
    environment: Environment;
    status: TraceStatus;
    startedAt: string;
    endedAt: string | null;
    durationMs: number | null;
    endUserId: string | null;
    sessionId: string | null;
    tags: string[];
    metadata: Record<string, unknown>;
    input: unknown;
    output: unknown;
    /** False while spans reference a parent that has not arrived yet. */
    isComplete: boolean;
    isSimulated: boolean;
  };
  totals: {
    spans: number;
    llmCalls: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costUsd: string;
    errors: number;
  };
  /** Ordered by start time. */
  spans: SpanDto[];
  /** Errors recorded on the trace itself rather than on a span. */
  errors: SpanErrorDto[];
  evaluations: EvaluationDto[];
}

/* ------------------------------------------------------------ prompt history */

export const generationsQuerySchema = analyticsQuerySchema.and(
  z.object({
    q: search,
    status: z.enum(TRACE_STATUSES).optional(),
    /** Only calls whose input matches this fingerprint (see repeated prompts). */
    inputHash: z
      .string()
      .regex(/^[0-9a-f]{32}$/)
      .optional(),
    limit: pageLimit,
    cursor,
  }),
);
export type GenerationsQuery = z.infer<typeof generationsQuerySchema>;

export interface GenerationItem {
  uid: string;
  traceId: string;
  traceName: string;
  spanId: string;
  spanName: string;
  provider: string | null;
  model: string | null;
  status: TraceStatus;
  startedAt: string;
  durationMs: number | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: string | null;
  inputHash: string | null;
  promptPreview: string;
  responsePreview: string;
}

export interface GenerationsPage {
  items: GenerationItem[];
  nextCursor: string | null;
}

export interface GenerationDetailDto {
  traceId: string;
  traceName: string;
  environment: Environment;
  span: SpanDto;
}

export interface RepeatedPromptDto {
  inputHash: string;
  calls: number;
  /** Distinct completions: 1 means the same prompt always produced the same answer (cacheable). */
  distinctOutputs: number;
  /** Span names using this prompt (e.g. which step of the pipeline sends it). */
  spanNames: string[];
  models: string[];
  avgLatencyMs: number | null;
  totalCostUsd: string;
  firstSeenAt: string;
  lastSeenAt: string;
  promptPreview: string;
  /** Most recent call, for drill-down. */
  latestUid: string;
}

/* --------------------------------------------------------------- evaluations */

export const CRITERION_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/;

export const criterionInputSchema = z
  .object({
    name: z
      .string()
      .trim()
      .regex(CRITERION_NAME_PATTERN, 'Use letters, numbers, dots, dashes or underscores'),
    description: z.string().trim().max(500).optional(),
    kind: z.enum(EVALUATION_KINDS),
    minScore: z.number().finite().optional(),
    maxScore: z.number().finite().optional(),
    labels: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
  })
  .refine(
    (input) =>
      input.kind !== 'numeric' ||
      (input.minScore !== undefined &&
        input.maxScore !== undefined &&
        input.minScore < input.maxScore),
    { message: 'Numeric criteria need minScore < maxScore', path: ['maxScore'], ...onlyIfValid },
  )
  .refine(
    (input) =>
      input.kind !== 'categorical' ||
      (input.labels !== undefined &&
        input.labels.length >= 2 &&
        new Set(input.labels).size === input.labels.length),
    {
      message: 'Categorical criteria need at least two distinct labels',
      path: ['labels'],
      ...onlyIfValid,
    },
  );
export type CriterionInput = z.infer<typeof criterionInputSchema>;

export interface CriterionDto {
  id: string;
  name: string;
  description: string | null;
  kind: EvaluationKind;
  minScore: number | null;
  maxScore: number | null;
  labels: string[];
  createdAt: string;
}

/** A manual evaluation from the UI. Re-submitting the same criterion for the same target updates it. */
export const createEvaluationSchema = z
  .object({
    spanId: z.string().trim().min(1).max(128).optional(),
    criterion: z.string().trim().regex(CRITERION_NAME_PATTERN),
    kind: z.enum(EVALUATION_KINDS),
    score: z.number().finite().optional(),
    label: z.string().trim().min(1).max(200).optional(),
    comment: z.string().trim().max(5_000).optional(),
  })
  .refine((input) => input.kind !== 'thumbs' || input.score === 0 || input.score === 1, {
    message: 'thumbs evaluations need score 0 (down) or 1 (up)',
    path: ['score'],
    ...onlyIfValid,
  })
  .refine((input) => input.kind !== 'numeric' || input.score !== undefined, {
    message: 'numeric evaluations need a score',
    path: ['score'],
    ...onlyIfValid,
  })
  .refine((input) => input.kind !== 'categorical' || input.label !== undefined, {
    message: 'categorical evaluations need a label',
    path: ['label'],
    ...onlyIfValid,
  });
export type CreateEvaluationInput = z.infer<typeof createEvaluationSchema>;

export const evaluationsQuerySchema = analyticsQuerySchema.and(
  z.object({
    criterion: z.string().max(100).optional(),
    source: z.enum(EVALUATION_SOURCES).optional(),
    limit: pageLimit,
    cursor,
  }),
);
export type EvaluationsQuery = z.infer<typeof evaluationsQuerySchema>;

export interface EvaluationListItem extends EvaluationDto {
  traceName: string;
}

export interface EvaluationsPage {
  items: EvaluationListItem[];
  nextCursor: string | null;
}

export interface CriterionSummary {
  criterion: string;
  kind: EvaluationKind;
  count: number;
  /** Mean score (thumbs: share of thumbs-up). Null when no evaluation has a score. */
  average: number | null;
  /** Thumbs only: thumbs-up / thumbs-down counts. */
  positive: number;
  negative: number;
  /** Categorical: count per label. */
  labels: Array<{ label: string; count: number }>;
  definition: CriterionDto | null;
  series: Array<{ t: string; count: number; average: number | null }>;
}

export interface EvaluationSummaryDto {
  bucket: BucketSize;
  total: number;
  bySource: Array<{ source: EvaluationSource; count: number }>;
  /** Share of traces in the range with at least one evaluation, 0..1. */
  coverage: number;
  criteria: CriterionSummary[];
}

/* --------------------------------------------------------------- text helpers */

/** Text of a message `content`, which may be a string or a list of typed parts. */
function contentText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((part) =>
        typeof part === 'string'
          ? part
          : part &&
              typeof part === 'object' &&
              typeof (part as { text?: unknown }).text === 'string'
            ? (part as { text: string }).text
            : null,
      )
      .filter((part): part is string => part !== null);
    return parts.length > 0 ? parts.join(' ') : null;
  }
  return null;
}

interface MessageLike {
  role?: unknown;
  content?: unknown;
}

function messagesOf(value: unknown): MessageLike[] | null {
  if (Array.isArray(value) && value.every((item) => item && typeof item === 'object'))
    return value as MessageLike[];
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.messages)) return record.messages as MessageLike[];
    if (Array.isArray(record.choices)) {
      return (record.choices as Array<{ message?: MessageLike }>)
        .map((choice) => choice?.message)
        .filter((message): message is MessageLike => Boolean(message));
    }
  }
  return null;
}

/**
 * Human-readable summary of an LLM payload: for prompts the last user message, for responses the
 * last message's text. Falls back to compact JSON. Used for previews only, never for analytics.
 */
export function payloadText(value: unknown, role: 'prompt' | 'response'): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  const messages = messagesOf(value);
  if (messages && messages.length > 0) {
    const preferred =
      role === 'prompt'
        ? [...messages].reverse().find((message) => message.role === 'user')
        : undefined;
    const message = preferred ?? messages.at(-1);
    const text = message ? contentText(message.content) : null;
    if (text !== null) return text;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const text = contentText(record.content) ?? contentText(record.text);
    if (text !== null) return text;
  }
  return JSON.stringify(value);
}

export function preview(text: string, maxLength = 240): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1)}…`;
}
