import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  payloadText,
  preview,
  type Environment,
  type ErrorType,
  type EvaluationDto,
  type EvaluationKind,
  type EvaluationSource,
  type GenerationDetailDto,
  type GenerationItem,
  type GenerationsPage,
  type GenerationsQuery,
  type RepeatedPromptDto,
  type SpanDto,
  type SpanErrorDto,
  type SpanKind,
  type TraceDetailDto,
  type TraceListItem,
  type TraceStatus,
  type TracesPage,
  type TracesQuery,
  type AnalyticsQuery,
} from '@tracemind/shared';
import { sql, type SQL } from 'drizzle-orm';
import {
  afterCursor,
  floatOrNull,
  iso,
  isoOrNull,
  llmSpanFilters,
  num,
  numOrNull,
  paginate,
  rows,
  strOrNull,
  toRange,
  tsQuery,
  type Row,
} from '../common/telemetry-sql.js';
import { DATABASE, type Database } from '../database/database.module.js';

const PREVIEW_LENGTH = 220;

/**
 * Read side of the Trace Explorer and prompt history. Everything is read from raw telemetry;
 * list endpoints use keyset pagination on (started_at, id) so deep pages stay cheap.
 */
@Injectable()
export class TracesService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /* ------------------------------------------------------------------ traces */

  async list(projectId: string, query: TracesQuery): Promise<TracesPage> {
    const range = toRange(query);
    const conditions: SQL[] = [
      sql`t.project_id = ${projectId}`,
      sql`t.started_at >= ${range.from.toISOString()}::timestamptz`,
      sql`t.started_at < ${range.to.toISOString()}::timestamptz`,
    ];
    if (query.environment) conditions.push(sql`t.environment = ${query.environment}`);
    if (query.status) conditions.push(sql`t.status = ${query.status}`);
    if (query.minDurationMs !== undefined)
      conditions.push(sql`t.duration_ms >= ${query.minDurationMs}`);
    if (query.userId) conditions.push(sql`t.end_user_id = ${query.userId}`);
    if (query.sessionId) conditions.push(sql`t.session_id = ${query.sessionId}`);
    if (query.provider || query.model) {
      const model: SQL[] = [sql`s.trace_id = t.id`, sql`s.kind = 'llm'`];
      if (query.provider) model.push(sql`s.provider_id = ${query.provider}`);
      if (query.model) model.push(sql`s.model = ${query.model}`);
      conditions.push(sql`EXISTS (SELECT 1 FROM spans s WHERE ${sql.join(model, sql` AND `)})`);
    }
    if (query.q) {
      // Span matches go through the GIN index first, then are mapped to their traces.
      conditions.push(sql`(
        t.external_id = ${query.q}
        OR t.search @@ ${tsQuery(query.q)}
        OR t.id IN (
          SELECT s.trace_id FROM spans s
          WHERE s.project_id = ${projectId} AND s.search @@ ${tsQuery(query.q)}
        )
      )`);
    }

    const result = await rows(
      this.db,
      sql`
        WITH page AS (
          SELECT t.id, t.external_id, t.name, t.environment, t.status, t.started_at, t.duration_ms,
                 t.end_user_id, t.session_id, t.tags, t.is_simulated
          FROM traces t
          WHERE ${sql.join(conditions, sql` AND `)}
                ${afterCursor(sql`t.started_at`, sql`t.id`, query.cursor)}
          ORDER BY t.started_at DESC, t.id DESC
          LIMIT ${query.limit + 1}
        )
        SELECT p.*, agg.span_count, agg.llm_calls, agg.total_tokens, agg.cost, agg.models,
               (SELECT count(*) FROM errors e WHERE e.trace_id = p.id)           AS error_count,
               (SELECT count(*) FROM evaluations v WHERE v.trace_id = p.id)      AS evaluation_count
        FROM page p
        LEFT JOIN LATERAL (
          SELECT count(*)                                                       AS span_count,
                 count(*) FILTER (WHERE s.kind = 'llm')                         AS llm_calls,
                 coalesce(sum(u.total_tokens), 0)                               AS total_tokens,
                 coalesce(sum(u.estimated_cost_usd), 0)::numeric(18, 8)::text   AS cost,
                 coalesce(array_agg(DISTINCT s.model) FILTER (WHERE s.model IS NOT NULL), '{}') AS models
          FROM spans s LEFT JOIN token_usage u ON u.span_id = s.id
          WHERE s.trace_id = p.id
        ) agg ON true
        ORDER BY p.started_at DESC, p.id DESC
      `,
    );

    const { visible, nextCursor } = paginate(result, query.limit, (row) => ({
      at: row.started_at,
      id: row.id,
    }));
    return { items: visible.map(toTraceListItem), nextCursor };
  }

  async detail(projectId: string, externalId: string): Promise<TraceDetailDto> {
    const [trace] = await rows(
      this.db,
      sql`SELECT * FROM traces WHERE project_id = ${projectId} AND external_id = ${externalId}`,
    );
    if (!trace) throw new NotFoundException('Trace not found');
    const traceId = String(trace.id);

    const [spanRows, errorRows, evaluationRows] = await Promise.all([
      rows(
        this.db,
        sql`
          SELECT s.*, p.external_id AS parent_external, u.input_tokens, u.output_tokens,
                 u.cached_input_tokens, u.total_tokens, u.span_id AS usage_span,
                 u.estimated_cost_usd::text AS estimated_cost, u.reported_cost_usd::text AS reported_cost
          FROM spans s
          LEFT JOIN spans p ON p.id = s.parent_span_id
          LEFT JOIN token_usage u ON u.span_id = s.id
          WHERE s.trace_id = ${traceId}
          ORDER BY s.started_at, s.created_at
        `,
      ),
      rows(this.db, sql`SELECT * FROM errors WHERE trace_id = ${traceId} ORDER BY occurred_at`),
      this.evaluationsFor(traceId, String(trace.external_id)),
    ]);

    const errorsBySpan = new Map<string, SpanErrorDto[]>();
    const traceErrors: SpanErrorDto[] = [];
    for (const row of errorRows) {
      const error = toSpanError(row);
      if (row.span_id === null) traceErrors.push(error);
      else
        errorsBySpan.set(String(row.span_id), [
          ...(errorsBySpan.get(String(row.span_id)) ?? []),
          error,
        ]);
    }
    const spans = spanRows.map((row) => toSpan(row, errorsBySpan.get(String(row.id)) ?? []));
    const totals = spans.reduce(
      (sum, span) => ({
        spans: sum.spans + 1,
        llmCalls: sum.llmCalls + (span.kind === 'llm' ? 1 : 0),
        inputTokens: sum.inputTokens + (span.usage?.inputTokens ?? 0),
        outputTokens: sum.outputTokens + (span.usage?.outputTokens ?? 0),
        totalTokens: sum.totalTokens + (span.usage?.totalTokens ?? 0),
        errors: sum.errors + span.errors.length,
      }),
      { spans: 0, llmCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, errors: 0 },
    );
    // Money is summed in SQL to stay exact; floats would drift on many small amounts.
    const [cost] = await rows(
      this.db,
      sql`SELECT coalesce(sum(u.estimated_cost_usd), 0)::numeric(18, 8)::text AS cost
          FROM token_usage u JOIN spans s ON s.id = u.span_id WHERE s.trace_id = ${traceId}`,
    );

    return {
      trace: {
        id: String(trace.external_id),
        name: String(trace.name),
        environment: trace.environment as Environment,
        status: trace.status as TraceStatus,
        startedAt: iso(trace.started_at),
        endedAt: isoOrNull(trace.ended_at),
        durationMs: numOrNull(trace.duration_ms),
        endUserId: strOrNull(trace.end_user_id),
        sessionId: strOrNull(trace.session_id),
        tags: (trace.tags as string[] | null) ?? [],
        metadata: (trace.metadata as Record<string, unknown> | null) ?? {},
        input: trace.input ?? null,
        output: trace.output ?? null,
        isComplete: Boolean(trace.is_complete),
        isSimulated: Boolean(trace.is_simulated),
      },
      totals: {
        ...totals,
        errors: totals.errors + traceErrors.length,
        costUsd: String(cost?.cost ?? '0.00000000'),
      },
      spans,
      errors: traceErrors,
      evaluations: evaluationRows,
    };
  }

  /** Evaluations of one trace, newest first, with span ids translated to client ids. */
  async evaluationsFor(traceId: string, externalTraceId: string): Promise<EvaluationDto[]> {
    const result = await rows(
      this.db,
      sql`
        SELECT v.*, s.external_id AS span_external, u.name AS user_name
        FROM evaluations v
        LEFT JOIN spans s ON s.id = v.span_id
        LEFT JOIN users u ON u.id = v.created_by_id
        WHERE v.trace_id = ${traceId}
        ORDER BY v.created_at DESC, v.id DESC
      `,
    );
    return result.map((row) => toEvaluation(row, externalTraceId));
  }

  /* ---------------------------------------------------------- prompt history */

  async generations(projectId: string, query: GenerationsQuery): Promise<GenerationsPage> {
    const conditions: SQL[] = [llmSpanFilters(projectId, query, toRange(query))];
    if (query.status) conditions.push(sql`s.status = ${query.status}`);
    if (query.inputHash) conditions.push(sql`s.input_hash = ${query.inputHash}`);
    if (query.q) conditions.push(sql`s.search @@ ${tsQuery(query.q)}`);

    const result = await rows(
      this.db,
      sql`
        SELECT s.id, s.external_id, s.name, s.provider_id, s.model, s.status, s.started_at, s.duration_ms,
               s.input, s.output, s.input_hash, t.external_id AS trace_id, t.name AS trace_name,
               u.input_tokens, u.output_tokens, u.estimated_cost_usd::text AS cost
        FROM spans s
        JOIN traces t ON t.id = s.trace_id
        LEFT JOIN token_usage u ON u.span_id = s.id
        WHERE ${sql.join(conditions, sql` AND `)}
              ${afterCursor(sql`s.started_at`, sql`s.id`, query.cursor)}
        ORDER BY s.started_at DESC, s.id DESC
        LIMIT ${query.limit + 1}
      `,
    );
    const { visible, nextCursor } = paginate(result, query.limit, (row) => ({
      at: row.started_at,
      id: row.id,
    }));
    return { items: visible.map(toGeneration), nextCursor };
  }

  async generation(projectId: string, uid: string): Promise<GenerationDetailDto> {
    const [row] = await rows(
      this.db,
      sql`
        SELECT s.*, p.external_id AS parent_external, t.external_id AS trace_external,
               t.name AS trace_name, t.environment, u.input_tokens, u.output_tokens,
               u.cached_input_tokens, u.total_tokens, u.span_id AS usage_span,
               u.estimated_cost_usd::text AS estimated_cost, u.reported_cost_usd::text AS reported_cost
        FROM spans s
        JOIN traces t ON t.id = s.trace_id
        LEFT JOIN spans p ON p.id = s.parent_span_id
        LEFT JOIN token_usage u ON u.span_id = s.id
        WHERE s.project_id = ${projectId} AND s.id = ${uid}
      `,
    );
    if (!row) throw new NotFoundException('Span not found');
    const errorRows = await rows(
      this.db,
      sql`SELECT * FROM errors WHERE span_id = ${uid} ORDER BY occurred_at`,
    );
    return {
      traceId: String(row.trace_external),
      traceName: String(row.trace_name),
      environment: row.environment as Environment,
      span: toSpan(row, errorRows.map(toSpanError)),
    };
  }

  /**
   * Identical inputs (same messages, system prompt and tool definitions) sent more than once in
   * the range — candidates for response caching or prompt deduplication.
   */
  async repeatedPrompts(projectId: string, query: AnalyticsQuery): Promise<RepeatedPromptDto[]> {
    const result = await rows(
      this.db,
      sql`
        SELECT s.input_hash,
               count(*)                                                        AS calls,
               count(DISTINCT md5(s.output::text))                             AS distinct_outputs,
               array_agg(DISTINCT s.name)                                      AS span_names,
               coalesce(array_agg(DISTINCT s.model) FILTER (WHERE s.model IS NOT NULL), '{}') AS models,
               avg(s.duration_ms)                                              AS avg_latency,
               coalesce(sum(u.estimated_cost_usd), 0)::numeric(18, 8)::text    AS cost,
               min(s.started_at)                                               AS first_seen,
               max(s.started_at)                                               AS last_seen,
               (array_agg(s.id ORDER BY s.started_at DESC))[1]                 AS latest
        FROM spans s
        JOIN traces t ON t.id = s.trace_id
        LEFT JOIN token_usage u ON u.span_id = s.id
        WHERE ${llmSpanFilters(projectId, query, toRange(query))} AND s.input_hash IS NOT NULL
        GROUP BY s.input_hash
        HAVING count(*) > 1
        ORDER BY calls DESC, cost DESC
        LIMIT 50
      `,
    );
    if (result.length === 0) return [];

    const ids = result.map((row) => String(row.latest));
    const inputs = await rows(
      this.db,
      sql`SELECT id, input FROM spans WHERE id IN (${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`,
    );
    const inputById = new Map(inputs.map((row) => [String(row.id), row.input]));

    return result.map((row) => ({
      inputHash: String(row.input_hash),
      calls: num(row.calls),
      distinctOutputs: num(row.distinct_outputs),
      spanNames: (row.span_names as string[] | null) ?? [],
      models: (row.models as string[] | null) ?? [],
      avgLatencyMs: numOrNull(row.avg_latency),
      totalCostUsd: String(row.cost),
      firstSeenAt: iso(row.first_seen),
      lastSeenAt: iso(row.last_seen),
      promptPreview: preview(
        payloadText(inputById.get(String(row.latest)), 'prompt'),
        PREVIEW_LENGTH,
      ),
      latestUid: String(row.latest),
    }));
  }
}

/* ------------------------------------------------------------------ mappers */

function toTraceListItem(row: Row): TraceListItem {
  return {
    id: String(row.external_id),
    name: String(row.name),
    environment: row.environment as Environment,
    status: row.status as TraceStatus,
    startedAt: iso(row.started_at),
    durationMs: numOrNull(row.duration_ms),
    spanCount: num(row.span_count),
    llmCalls: num(row.llm_calls),
    totalTokens: num(row.total_tokens),
    costUsd: String(row.cost ?? '0.00000000'),
    models: (row.models as string[] | null) ?? [],
    errorCount: num(row.error_count),
    evaluationCount: num(row.evaluation_count),
    endUserId: strOrNull(row.end_user_id),
    sessionId: strOrNull(row.session_id),
    tags: (row.tags as string[] | null) ?? [],
    isSimulated: Boolean(row.is_simulated),
  };
}

function toSpanError(row: Row): SpanErrorDto {
  return {
    type: row.type as ErrorType,
    message: String(row.message),
    code: strOrNull(row.code),
    httpStatus: numOrNull(row.http_status),
    occurredAt: iso(row.occurred_at),
  };
}

function toSpan(row: Row, errors: SpanErrorDto[]): SpanDto {
  return {
    uid: String(row.id),
    id: String(row.external_id),
    parentId: strOrNull(row.parent_external),
    name: String(row.name),
    kind: row.kind as SpanKind,
    status: row.status as TraceStatus,
    provider: strOrNull(row.provider_id),
    model: strOrNull(row.model),
    input: row.input ?? null,
    output: row.output ?? null,
    modelParameters: (row.model_parameters as Record<string, unknown> | null) ?? null,
    metadata: (row.metadata as Record<string, unknown> | null) ?? {},
    startedAt: iso(row.started_at),
    endedAt: isoOrNull(row.ended_at),
    durationMs: numOrNull(row.duration_ms),
    usage:
      row.usage_span === null || row.usage_span === undefined
        ? null
        : {
            inputTokens: num(row.input_tokens),
            outputTokens: num(row.output_tokens),
            cachedInputTokens: num(row.cached_input_tokens),
            totalTokens: num(row.total_tokens),
            estimatedCostUsd: strOrNull(row.estimated_cost),
            reportedCostUsd: strOrNull(row.reported_cost),
          },
    errors,
  };
}

function toGeneration(row: Row): GenerationItem {
  return {
    uid: String(row.id),
    traceId: String(row.trace_id),
    traceName: String(row.trace_name),
    spanId: String(row.external_id),
    spanName: String(row.name),
    provider: strOrNull(row.provider_id),
    model: strOrNull(row.model),
    status: row.status as TraceStatus,
    startedAt: iso(row.started_at),
    durationMs: numOrNull(row.duration_ms),
    inputTokens: num(row.input_tokens),
    outputTokens: num(row.output_tokens),
    costUsd: strOrNull(row.cost),
    inputHash: strOrNull(row.input_hash),
    promptPreview: preview(payloadText(row.input, 'prompt'), PREVIEW_LENGTH),
    responsePreview: preview(payloadText(row.output, 'response'), PREVIEW_LENGTH),
  };
}

export function toEvaluation(row: Row, externalTraceId: string): EvaluationDto {
  return {
    id: String(row.id),
    traceId: externalTraceId,
    spanId: strOrNull(row.span_external),
    criterion: String(row.criterion),
    kind: row.kind as EvaluationKind,
    score: floatOrNull(row.score),
    label: strOrNull(row.label),
    comment: strOrNull(row.comment),
    source: row.source as EvaluationSource,
    createdBy:
      row.created_by_id === null || row.created_by_id === undefined
        ? null
        : { id: String(row.created_by_id), name: String(row.user_name ?? 'Unknown user') },
    createdAt: iso(row.created_at),
  };
}
