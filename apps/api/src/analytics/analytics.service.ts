import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  bucketFor,
  type AnalyticsQuery,
  type BreakdownRow,
  type CostsDto,
  type DimensionsDto,
  type Environment,
  type ErrorType,
  type ErrorsDto,
  type ErrorsQuery,
  type OverviewDto,
  type PerformanceDto,
  type PeriodTotals,
  type TimeseriesDto,
} from '@tracemind/shared';
import { sql, type SQL } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import { ENV, type Env } from '../config/env.js';
import { DATABASE, type Database } from '../database/database.module.js';
import { REDIS } from '../redis/redis.module.js';

/**
 * Analytics over raw telemetry. Every number is computed from spans/token_usage/errors at query
 * time (optionally cached for a few seconds), so it always matches the underlying requests.
 *
 * Conventions:
 * - A "request" is an LLM call: a span of kind `llm`, attributed to the time it started.
 * - Percentiles use percentile_cont over the exact filtered set — never averaged per bucket.
 * - Money stays NUMERIC in SQL and travels as decimal strings; only chart series use floats.
 * - Buckets are aligned to the caller's time zone (days start at local midnight).
 */

/** Monday 2000-01-03 00:00: weekly buckets start on Mondays; hourly/daily on the hour/midnight. */
const BUCKET_ORIGIN = '2000-01-03 00:00:00';
const HISTOGRAM_EDGES_MS = [250, 500, 1_000, 2_000, 4_000, 8_000, 16_000, 32_000];

type Row = Record<string, unknown>;

const num = (value: unknown): number => (value === null || value === undefined ? 0 : Number(value));
const numOrNull = (value: unknown): number | null =>
  value === null || value === undefined ? null : Math.round(Number(value));
const iso = (value: unknown): string => new Date(value as string | Date).toISOString();

interface Range {
  from: Date;
  to: Date;
}

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /* ---------------------------------------------------------------- overview */

  overview(projectId: string, query: AnalyticsQuery): Promise<OverviewDto> {
    return this.cached(projectId, 'overview', query, async () => {
      const current = this.range(query);
      const span = current.to.getTime() - current.from.getTime();
      const previous = { from: new Date(current.from.getTime() - span), to: current.from };
      const [now, before] = await Promise.all([
        this.totals(projectId, query, current),
        this.totals(projectId, query, previous),
      ]);
      return { current: now, previous: before };
    });
  }

  private async totals(
    projectId: string,
    query: AnalyticsQuery,
    range: Range,
  ): Promise<PeriodTotals> {
    const rows = await this.rows(sql`
      SELECT
        count(*)                                                         AS requests,
        count(DISTINCT s.trace_id)                                       AS traces,
        count(*) FILTER (WHERE s.status = 'error')                       AS errors,
        count(*) FILTER (WHERE e.type = 'timeout')                       AS timeouts,
        count(*) FILTER (WHERE e.type = 'rate_limit')                    AS rate_limits,
        coalesce(sum(u.input_tokens), 0)                                 AS input_tokens,
        coalesce(sum(u.output_tokens), 0)                                AS output_tokens,
        coalesce(sum(u.cached_input_tokens), 0)                          AS cached_input_tokens,
        coalesce(sum(u.total_tokens), 0)                                 AS total_tokens,
        coalesce(sum(u.estimated_cost_usd), 0)::numeric(18, 8)::text     AS estimated_cost,
        coalesce(sum(u.reported_cost_usd), 0)::numeric(18, 8)::text      AS reported_cost,
        count(*) FILTER (WHERE u.span_id IS NOT NULL AND u.estimated_cost_usd IS NULL) AS unpriced,
        avg(s.duration_ms)                                               AS avg_latency,
        percentile_cont(0.50) WITHIN GROUP (ORDER BY s.duration_ms)      AS p50,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY s.duration_ms)      AS p95,
        percentile_cont(0.99) WITHIN GROUP (ORDER BY s.duration_ms)      AS p99
      ${this.fromLlmSpans(true)}
      WHERE ${this.spanFilters(projectId, query, range)}
    `);
    const row = rows[0] ?? {};
    const requests = num(row.requests);
    const minutes = Math.max(1, (range.to.getTime() - range.from.getTime()) / 60_000);
    return {
      requests,
      traces: num(row.traces),
      errors: num(row.errors),
      errorRate: requests === 0 ? 0 : num(row.errors) / requests,
      timeouts: num(row.timeouts),
      rateLimits: num(row.rate_limits),
      inputTokens: num(row.input_tokens),
      outputTokens: num(row.output_tokens),
      cachedInputTokens: num(row.cached_input_tokens),
      totalTokens: num(row.total_tokens),
      estimatedCostUsd: String(row.estimated_cost ?? '0.00000000'),
      reportedCostUsd: String(row.reported_cost ?? '0.00000000'),
      unpricedRequests: num(row.unpriced),
      avgLatencyMs: numOrNull(row.avg_latency),
      p50LatencyMs: numOrNull(row.p50),
      p95LatencyMs: numOrNull(row.p95),
      p99LatencyMs: numOrNull(row.p99),
      throughputPerMinute: requests / minutes,
    };
  }

  /* -------------------------------------------------------------- timeseries */

  timeseries(projectId: string, query: AnalyticsQuery): Promise<TimeseriesDto> {
    return this.cached(projectId, 'timeseries', query, async () => {
      const range = this.range(query);
      const bucket = bucketFor(range.from.getTime(), range.to.getTime());
      const rows = await this.rows(sql`
        WITH agg AS (
          SELECT
            ${this.bucketExpr(sql`s.started_at`, bucket, query.tz)} AS b,
            count(*)                                                   AS requests,
            count(*) FILTER (WHERE s.status = 'error')                 AS errors,
            coalesce(sum(u.input_tokens), 0)                           AS input_tokens,
            coalesce(sum(u.output_tokens), 0)                          AS output_tokens,
            coalesce(sum(u.estimated_cost_usd), 0)                     AS cost,
            percentile_cont(0.50) WITHIN GROUP (ORDER BY s.duration_ms) AS p50,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY s.duration_ms) AS p95,
            percentile_cont(0.99) WITHIN GROUP (ORDER BY s.duration_ms) AS p99
          ${this.fromLlmSpans(false)}
          WHERE ${this.spanFilters(projectId, query, range)}
          GROUP BY 1
        )
        SELECT (buckets.b AT TIME ZONE ${query.tz}) AS t, agg.*
        FROM ${this.bucketSeries(range, bucket, query.tz)} AS buckets(b)
        LEFT JOIN agg ON agg.b = buckets.b
        ORDER BY buckets.b
      `);
      return {
        bucket,
        points: rows.map((row) => ({
          t: iso(row.t),
          requests: num(row.requests),
          errors: num(row.errors),
          inputTokens: num(row.input_tokens),
          outputTokens: num(row.output_tokens),
          costUsd: num(row.cost),
          p50LatencyMs: numOrNull(row.p50),
          p95LatencyMs: numOrNull(row.p95),
          p99LatencyMs: numOrNull(row.p99),
        })),
      };
    });
  }

  /* --------------------------------------------------------------- breakdown */

  breakdown(
    projectId: string,
    query: AnalyticsQuery,
    by: 'model' | 'provider',
  ): Promise<BreakdownRow[]> {
    return this.cached(projectId, `breakdown:${by}`, query, async () => {
      const groupModel = by === 'model';
      const rows = await this.rows(sql`
        SELECT
          s.provider_id                                               AS provider,
          ${groupModel ? sql`s.model` : sql`NULL::text`}              AS model,
          count(*)                                                    AS requests,
          count(*) FILTER (WHERE s.status = 'error')                  AS errors,
          coalesce(sum(u.input_tokens), 0)                            AS input_tokens,
          coalesce(sum(u.output_tokens), 0)                           AS output_tokens,
          coalesce(sum(u.estimated_cost_usd), 0)::numeric(18, 8)::text AS cost,
          avg(s.duration_ms)                                          AS avg_latency,
          percentile_cont(0.95) WITHIN GROUP (ORDER BY s.duration_ms) AS p95
        ${this.fromLlmSpans(false)}
        WHERE ${this.spanFilters(projectId, query, this.range(query))}
        GROUP BY 1, 2
        ORDER BY sum(u.estimated_cost_usd) DESC NULLS LAST, count(*) DESC
      `);
      const totalCost = rows.reduce((sum, row) => sum + Number(row.cost), 0);
      return rows.map((row) => ({
        provider: (row.provider as string | null) ?? null,
        model: (row.model as string | null) ?? null,
        requests: num(row.requests),
        errors: num(row.errors),
        inputTokens: num(row.input_tokens),
        outputTokens: num(row.output_tokens),
        costUsd: String(row.cost),
        costShare: totalCost > 0 ? Number(row.cost) / totalCost : 0,
        avgLatencyMs: numOrNull(row.avg_latency),
        p95LatencyMs: numOrNull(row.p95),
      }));
    });
  }

  /* ------------------------------------------------------------------- costs */

  costs(projectId: string, query: AnalyticsQuery): Promise<CostsDto> {
    return this.cached(projectId, 'costs', query, async () => {
      const range = this.range(query);
      const bucket = bucketFor(range.from.getTime(), range.to.getTime());
      const where = this.spanFilters(projectId, query, range);

      const [components, series, top] = await Promise.all([
        this.rows(sql`
          SELECT
            coalesce(sum(u.estimated_cost_usd), 0)::numeric(18, 8)::text AS estimated,
            coalesce(sum(u.reported_cost_usd), 0)::numeric(18, 8)::text  AS reported,
            round(coalesce(sum((u.input_tokens - u.cached_input_tokens) * p.input_price_per_million), 0) / 1000000.0, 8)::text AS input_cost,
            round(coalesce(sum(u.output_tokens * p.output_price_per_million), 0) / 1000000.0, 8)::text AS output_cost,
            round(coalesce(sum(u.cached_input_tokens * coalesce(p.cached_input_price_per_million, p.input_price_per_million)), 0) / 1000000.0, 8)::text AS cached_cost,
            round(coalesce(sum(u.cached_input_tokens * (p.input_price_per_million - coalesce(p.cached_input_price_per_million, p.input_price_per_million))), 0) / 1000000.0, 8)::text AS savings,
            count(*) FILTER (WHERE u.span_id IS NOT NULL AND u.estimated_cost_usd IS NULL) AS unpriced
          ${this.fromLlmSpans(false)}
          LEFT JOIN model_pricing p ON p.id = u.pricing_id
          WHERE ${where}
        `),
        this.rows(sql`
          SELECT (${this.bucketExpr(sql`s.started_at`, bucket, query.tz)} AT TIME ZONE ${query.tz}) AS t,
                 coalesce(s.model, '(unknown)') AS model,
                 sum(u.estimated_cost_usd) AS cost
          ${this.fromLlmSpans(false)}
          WHERE ${where} AND u.estimated_cost_usd IS NOT NULL
          GROUP BY 1, 2
          ORDER BY 1, 2
        `),
        this.rows(sql`
          SELECT t.external_id AS trace_id, t.name AS trace_name, s.name AS span_name, s.provider_id, s.model,
                 u.input_tokens, u.output_tokens, u.estimated_cost_usd::text AS cost, s.started_at
          ${this.fromLlmSpans(false)}
          WHERE ${where} AND u.estimated_cost_usd IS NOT NULL
          ORDER BY u.estimated_cost_usd DESC, s.started_at DESC
          LIMIT 10
        `),
      ]);

      const totals = components[0] ?? {};
      return {
        estimatedCostUsd: String(totals.estimated ?? '0.00000000'),
        reportedCostUsd: String(totals.reported ?? '0.00000000'),
        inputCostUsd: String(totals.input_cost ?? '0.00000000'),
        outputCostUsd: String(totals.output_cost ?? '0.00000000'),
        cachedInputCostUsd: String(totals.cached_cost ?? '0.00000000'),
        cacheSavingsUsd: String(totals.savings ?? '0.00000000'),
        unpricedRequests: num(totals.unpriced),
        bucket,
        series: series.map((row) => ({
          t: iso(row.t),
          model: String(row.model),
          costUsd: num(row.cost),
        })),
        topRequests: top.map((row) => ({
          traceId: String(row.trace_id),
          traceName: String(row.trace_name),
          spanName: String(row.span_name),
          provider: (row.provider_id as string | null) ?? null,
          model: (row.model as string | null) ?? null,
          inputTokens: num(row.input_tokens),
          outputTokens: num(row.output_tokens),
          costUsd: String(row.cost),
          startedAt: iso(row.started_at),
        })),
      };
    });
  }

  /* ------------------------------------------------------------- performance */

  performance(projectId: string, query: AnalyticsQuery): Promise<PerformanceDto> {
    return this.cached(projectId, 'performance', query, async () => {
      const where = this.spanFilters(projectId, query, this.range(query));
      const edges = sql.raw(`ARRAY[${HISTOGRAM_EDGES_MS.join(',')}]::int[]`);
      const [histogram, slowest] = await Promise.all([
        this.rows(sql`
          SELECT width_bucket(s.duration_ms, ${edges}) AS bucket, count(*) AS requests
          ${this.fromLlmSpans(false)}
          WHERE ${where} AND s.duration_ms IS NOT NULL
          GROUP BY 1
        `),
        this.rows(sql`
          SELECT t.external_id AS trace_id, t.name AS trace_name, s.name AS span_name, s.model,
                 s.duration_ms, s.status, s.started_at
          ${this.fromLlmSpans(false)}
          WHERE ${where} AND s.duration_ms IS NOT NULL
          ORDER BY s.duration_ms DESC, s.started_at DESC
          LIMIT 10
        `),
      ]);

      const counts = new Map(histogram.map((row) => [num(row.bucket), num(row.requests)]));
      const bounds = [0, ...HISTOGRAM_EDGES_MS];
      return {
        histogram: bounds.map((fromMs, index) => ({
          fromMs,
          toMs: HISTOGRAM_EDGES_MS[index] ?? null,
          requests: counts.get(index) ?? 0,
        })),
        slowest: slowest.map((row) => ({
          traceId: String(row.trace_id),
          traceName: String(row.trace_name),
          spanName: String(row.span_name),
          model: (row.model as string | null) ?? null,
          durationMs: num(row.duration_ms),
          status: String(row.status),
          startedAt: iso(row.started_at),
        })),
      };
    });
  }

  /* ------------------------------------------------------------------ errors */

  async errors(projectId: string, query: ErrorsQuery): Promise<ErrorsDto> {
    const range = this.range(query);
    const bucket = bucketFor(range.from.getTime(), range.to.getTime());
    const conditions: SQL[] = [
      sql`e.project_id = ${projectId}`,
      sql`e.occurred_at >= ${range.from.toISOString()}::timestamptz`,
      sql`e.occurred_at < ${range.to.toISOString()}::timestamptz`,
    ];
    if (query.environment) conditions.push(sql`t.environment = ${query.environment}`);
    if (query.provider) conditions.push(sql`e.provider_id = ${query.provider}`);
    if (query.model) conditions.push(sql`e.model = ${query.model}`);
    const where = sql.join(conditions, sql` AND `);
    const typeFilter = query.type ? sql` AND e.type = ${query.type}` : sql``;

    const cursor = decodeCursor(query.cursor);
    const page = cursor
      ? sql` AND (e.occurred_at, e.id) < (${cursor.occurredAt}::timestamptz, ${cursor.id}::uuid)`
      : sql``;

    const [byType, series, items] = await Promise.all([
      this.rows(sql`
        SELECT e.type, count(*) AS count
        FROM errors e JOIN traces t ON t.id = e.trace_id
        WHERE ${where}
        GROUP BY 1 ORDER BY 2 DESC
      `),
      this.rows(sql`
        SELECT (${this.bucketExpr(sql`e.occurred_at`, bucket, query.tz)} AT TIME ZONE ${query.tz}) AS t, e.type, count(*) AS count
        FROM errors e JOIN traces t ON t.id = e.trace_id
        WHERE ${where}${typeFilter}
        GROUP BY 1, 2 ORDER BY 1
      `),
      this.rows(sql`
        SELECT e.id, e.type, e.message, e.code, e.http_status, e.provider_id, e.model, e.occurred_at,
               t.external_id AS trace_id, t.name AS trace_name, s.name AS span_name
        FROM errors e
        JOIN traces t ON t.id = e.trace_id
        LEFT JOIN spans s ON s.id = e.span_id
        WHERE ${where}${typeFilter}${page}
        ORDER BY e.occurred_at DESC, e.id DESC
        LIMIT ${query.limit + 1}
      `),
    ]);

    const hasMore = items.length > query.limit;
    const visible = items.slice(0, query.limit);
    const last = visible.at(-1);
    return {
      byType: byType.map((row) => ({ type: row.type as ErrorType, count: num(row.count) })),
      series: series.map((row) => ({
        t: iso(row.t),
        type: row.type as ErrorType,
        count: num(row.count),
      })),
      bucket,
      items: visible.map((row) => ({
        id: String(row.id),
        type: row.type as ErrorType,
        message: String(row.message),
        code: (row.code as string | null) ?? null,
        httpStatus: (row.http_status as number | null) ?? null,
        provider: (row.provider_id as string | null) ?? null,
        model: (row.model as string | null) ?? null,
        occurredAt: iso(row.occurred_at),
        traceId: String(row.trace_id),
        traceName: String(row.trace_name),
        spanName: (row.span_name as string | null) ?? null,
      })),
      nextCursor: hasMore && last ? encodeCursor(iso(last.occurred_at), String(last.id)) : null,
    };
  }

  /* -------------------------------------------------------------- dimensions */

  async dimensions(projectId: string): Promise<DimensionsDto> {
    const [environments, models, bounds] = await Promise.all([
      this.rows(
        sql`SELECT DISTINCT environment FROM traces WHERE project_id = ${projectId} ORDER BY 1`,
      ),
      this.rows(sql`
        SELECT DISTINCT provider_id, model FROM spans
        WHERE project_id = ${projectId} AND kind = 'llm' AND model IS NOT NULL
        ORDER BY 1, 2
      `),
      this.rows(
        sql`SELECT min(started_at) AS first, max(started_at) AS last FROM spans WHERE project_id = ${projectId}`,
      ),
    ]);
    return {
      environments: environments.map((row) => row.environment as Environment),
      providers: [
        ...new Set(
          models.map((row) => row.provider_id as string | null).filter((p): p is string => !!p),
        ),
      ],
      models: models.map((row) => ({
        provider: (row.provider_id as string | null) ?? null,
        model: String(row.model),
      })),
      firstSeenAt: bounds[0]?.first ? iso(bounds[0].first) : null,
      lastSeenAt: bounds[0]?.last ? iso(bounds[0].last) : null,
    };
  }

  /* ----------------------------------------------------------------- helpers */

  private range(query: AnalyticsQuery): Range {
    return { from: new Date(query.from), to: new Date(query.to) };
  }

  private fromLlmSpans(withErrors: boolean): SQL {
    return sql`
      FROM spans s
      JOIN traces t ON t.id = s.trace_id
      LEFT JOIN token_usage u ON u.span_id = s.id
      ${withErrors ? sql`LEFT JOIN errors e ON e.span_id = s.id` : sql``}
    `;
  }

  private spanFilters(projectId: string, query: AnalyticsQuery, range: Range): SQL {
    const conditions: SQL[] = [
      sql`s.project_id = ${projectId}`,
      sql`s.kind = 'llm'`,
      sql`s.started_at >= ${range.from.toISOString()}::timestamptz`,
      sql`s.started_at < ${range.to.toISOString()}::timestamptz`,
    ];
    if (query.environment) conditions.push(sql`t.environment = ${query.environment}`);
    if (query.provider) conditions.push(sql`s.provider_id = ${query.provider}`);
    if (query.model) conditions.push(sql`s.model = ${query.model}`);
    return sql.join(conditions, sql` AND `);
  }

  /** Local-time bucket start (timestamp without time zone) for a timestamptz column. */
  private bucketExpr(column: SQL, bucket: string, tz: string): SQL {
    return sql`date_bin(${bucket}::interval, ${column} AT TIME ZONE ${tz}, ${BUCKET_ORIGIN}::timestamp)`;
  }

  /** Every bucket in the range, so charts show gaps as zeros instead of skipping them. */
  private bucketSeries(range: Range, bucket: string, tz: string): SQL {
    const from = sql`${range.from.toISOString()}::timestamptz`;
    const to = sql`${range.to.toISOString()}::timestamptz`;
    return sql`generate_series(
      date_bin(${bucket}::interval, ${from} AT TIME ZONE ${tz}, ${BUCKET_ORIGIN}::timestamp),
      (${to} - interval '1 microsecond') AT TIME ZONE ${tz},
      ${bucket}::interval
    )`;
  }

  private async rows(query: SQL): Promise<Row[]> {
    const result = await this.db.execute(query);
    return result.rows as Row[];
  }

  /** Short-lived Redis cache; analytics stay correct without it, so Redis errors are ignored. */
  private async cached<T>(
    projectId: string,
    name: string,
    query: unknown,
    compute: () => Promise<T>,
  ): Promise<T> {
    const ttl = this.env.ANALYTICS_CACHE_TTL_SECONDS;
    if (ttl <= 0) return compute();
    const key = `analytics:${projectId}:${name}:${createHash('sha1').update(JSON.stringify(query)).digest('hex')}`;
    try {
      const hit = await this.redis.get(key);
      if (hit) return JSON.parse(hit) as T;
    } catch (error) {
      this.logger.warn({ err: error }, 'Analytics cache read failed');
    }
    const value = await compute();
    this.redis.set(key, JSON.stringify(value), 'EX', ttl).catch((error: unknown) => {
      this.logger.warn({ err: error }, 'Analytics cache write failed');
    });
    return value;
  }
}

function encodeCursor(occurredAt: string, id: string): string {
  return Buffer.from(`${occurredAt}|${id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): { occurredAt: string; id: string } | null {
  if (!cursor) return null;
  const [occurredAt, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (!occurredAt || !id || Number.isNaN(Date.parse(occurredAt)) || !/^[0-9a-f-]{36}$/i.test(id))
    return null;
  return { occurredAt, id };
}
