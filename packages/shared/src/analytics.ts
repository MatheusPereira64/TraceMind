import { z } from 'zod';
import { ENVIRONMENTS, ERROR_TYPES, type Environment, type ErrorType } from './enums.js';

/**
 * Analytics contracts. Every metric is computed from persisted spans at query time; "requests"
 * are LLM calls (spans of kind `llm`), the unit people pay for and wait on.
 */

export const MAX_ANALYTICS_RANGE_DAYS = 400;

function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export const analyticsQuerySchema = z
  .object({
    from: z.iso.datetime({ offset: true }),
    to: z.iso.datetime({ offset: true }),
    environment: z.enum(ENVIRONMENTS).optional(),
    provider: z.string().max(64).optional(),
    model: z.string().max(200).optional(),
    /** IANA time zone used for bucket boundaries (e.g. days start at local midnight). */
    tz: z.string().max(64).refine(isValidTimeZone, 'Unknown time zone').default('UTC'),
  })
  .refine((query) => Date.parse(query.to) > Date.parse(query.from), {
    message: '`to` must be after `from`',
    path: ['to'],
  })
  .refine(
    (query) =>
      Date.parse(query.to) - Date.parse(query.from) <= MAX_ANALYTICS_RANGE_DAYS * 86_400_000,
    { message: `Range cannot exceed ${MAX_ANALYTICS_RANGE_DAYS} days`, path: ['from'] },
  );
export type AnalyticsQuery = z.infer<typeof analyticsQuerySchema>;
export type AnalyticsQueryInput = z.input<typeof analyticsQuerySchema>;

export const errorsQuerySchema = analyticsQuerySchema.and(
  z.object({
    type: z.enum(ERROR_TYPES).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().max(200).optional(),
  }),
);
export type ErrorsQuery = z.infer<typeof errorsQuerySchema>;

export type BucketSize = '1 hour' | '6 hours' | '1 day' | '1 week';

/** Bucket width that keeps charts between ~24 and ~60 points. */
export function bucketFor(fromMs: number, toMs: number): BucketSize {
  const hours = (toMs - fromMs) / 3_600_000;
  if (hours <= 48) return '1 hour';
  if (hours <= 24 * 10) return '6 hours';
  if (hours <= 24 * 92) return '1 day';
  return '1 week';
}

/* -------------------------------------------------------------------- responses */

export interface PeriodTotals {
  requests: number;
  traces: number;
  errors: number;
  /** errors / requests, 0..1 (0 when there are no requests). */
  errorRate: number;
  timeouts: number;
  rateLimits: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
  /** Decimal strings: exact NUMERIC from PostgreSQL. */
  estimatedCostUsd: string;
  reportedCostUsd: string;
  /** Requests with token usage but no matching price (excluded from the estimate). */
  unpricedRequests: number;
  avgLatencyMs: number | null;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  p99LatencyMs: number | null;
  /** Requests per minute over the selected range. */
  throughputPerMinute: number;
}

export interface OverviewDto {
  current: PeriodTotals;
  /** Same-length window immediately before `from`, for trend deltas. */
  previous: PeriodTotals;
}

export interface TimeseriesPoint {
  t: string;
  requests: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  p99LatencyMs: number | null;
}

export interface TimeseriesDto {
  bucket: BucketSize;
  points: TimeseriesPoint[];
}

export interface BreakdownRow {
  provider: string | null;
  model: string | null;
  requests: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: string;
  /** Share of total estimated cost, 0..1. */
  costShare: number;
  avgLatencyMs: number | null;
  p95LatencyMs: number | null;
}

export interface CostsDto {
  estimatedCostUsd: string;
  reportedCostUsd: string;
  inputCostUsd: string;
  outputCostUsd: string;
  cachedInputCostUsd: string;
  /** What cached tokens would have cost at the regular input price, minus what they cost. */
  cacheSavingsUsd: string;
  unpricedRequests: number;
  /** Cost per bucket and model, for stacked charts. */
  series: Array<{ t: string; model: string; costUsd: number }>;
  bucket: BucketSize;
  topRequests: Array<{
    traceId: string;
    traceName: string;
    spanName: string;
    provider: string | null;
    model: string | null;
    inputTokens: number;
    outputTokens: number;
    costUsd: string;
    startedAt: string;
  }>;
}

export interface PerformanceDto {
  histogram: Array<{ fromMs: number; toMs: number | null; requests: number }>;
  slowest: Array<{
    traceId: string;
    traceName: string;
    spanName: string;
    model: string | null;
    durationMs: number;
    status: string;
    startedAt: string;
  }>;
}

export interface ErrorItem {
  id: string;
  type: ErrorType;
  message: string;
  code: string | null;
  httpStatus: number | null;
  provider: string | null;
  model: string | null;
  occurredAt: string;
  traceId: string;
  traceName: string;
  spanName: string | null;
}

export interface ErrorsDto {
  byType: Array<{ type: ErrorType; count: number }>;
  series: Array<{ t: string; type: ErrorType; count: number }>;
  bucket: BucketSize;
  items: ErrorItem[];
  nextCursor: string | null;
}

export interface DimensionsDto {
  environments: Environment[];
  providers: string[];
  models: Array<{ provider: string | null; model: string }>;
  /** Earliest and latest telemetry, so the UI can pick a sensible default range. */
  firstSeenAt: string | null;
  lastSeenAt: string | null;
}

export interface PricingRowDto {
  provider: string;
  model: string;
  inputPricePerMillion: string;
  outputPricePerMillion: string;
  cachedInputPricePerMillion: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  source: string | null;
}
