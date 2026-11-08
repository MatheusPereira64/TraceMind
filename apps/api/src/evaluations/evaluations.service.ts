import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  bucketFor,
  hasRoleAtLeast,
  type CreateEvaluationInput,
  type CriterionDto,
  type CriterionInput,
  type CriterionSummary,
  type EvaluationDto,
  type EvaluationKind,
  type EvaluationSource,
  type EvaluationSummaryDto,
  type EvaluationsPage,
  type EvaluationsQuery,
  type OrganizationRole,
} from '@tracemind/shared';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import {
  afterCursor,
  floatOrNull,
  iso,
  num,
  paginate,
  rows,
  toRange,
  type Range,
} from '../common/telemetry-sql.js';
import { DATABASE, type Database } from '../database/database.module.js';
import { evaluationCriteria, evaluations } from '../database/schema.js';
import { toEvaluation } from '../traces/traces.service.js';

const BUCKET_ORIGIN = '2000-01-03 00:00:00';

type CriterionRow = typeof evaluationCriteria.$inferSelect;

export interface RecordEvaluationInput extends CreateEvaluationInput {
  source: EvaluationSource;
  userId?: string;
}

/**
 * Evaluations: criteria definitions, manual feedback from the UI and quality analytics. Scores
 * from the SDK arrive through ingestion; everything else goes through `record`.
 */
@Injectable()
export class EvaluationsService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /* ---------------------------------------------------------------- criteria */

  /** Criteria defined for the project, by name. */
  async criteria(projectId: string): Promise<CriterionDto[]> {
    const defined = await this.db
      .select()
      .from(evaluationCriteria)
      .where(eq(evaluationCriteria.projectId, projectId))
      .orderBy(evaluationCriteria.name);
    return defined.map(toCriterion);
  }

  async createCriterion(projectId: string, input: CriterionInput): Promise<CriterionDto> {
    const [row] = await this.db
      .insert(evaluationCriteria)
      .values({ projectId, ...criterionValues(input) })
      .onConflictDoNothing()
      .returning();
    if (!row) throw new ConflictException(`Criterion "${input.name}" already exists`);
    return toCriterion(row);
  }

  async updateCriterion(
    projectId: string,
    id: string,
    input: CriterionInput,
  ): Promise<CriterionDto> {
    const existing = await this.findCriterion(projectId, id);
    if (existing.name !== input.name || existing.kind !== input.kind)
      throw new BadRequestException(
        'The name and kind of a criterion cannot change: existing scores depend on them',
      );
    const [row] = await this.db
      .update(evaluationCriteria)
      .set(criterionValues(input))
      .where(eq(evaluationCriteria.id, id))
      .returning();
    return toCriterion(row!);
  }

  /** Removes the definition only; evaluations recorded against it are kept. */
  async deleteCriterion(projectId: string, id: string): Promise<void> {
    await this.findCriterion(projectId, id);
    await this.db.delete(evaluationCriteria).where(eq(evaluationCriteria.id, id));
  }

  private async findCriterion(projectId: string, id: string): Promise<CriterionRow> {
    const [row] = await this.db
      .select()
      .from(evaluationCriteria)
      .where(and(eq(evaluationCriteria.projectId, projectId), eq(evaluationCriteria.id, id)));
    if (!row) throw new NotFoundException('Criterion not found');
    return row;
  }

  /* ------------------------------------------------------------- evaluations */

  /**
   * Records an evaluation for a trace (or one of its spans). A user scoring the same target and
   * criterion again updates their previous score instead of adding a second one.
   */
  async record(
    projectId: string,
    externalTraceId: string,
    input: RecordEvaluationInput,
  ): Promise<EvaluationDto> {
    const [trace] = await rows(
      this.db,
      sql`SELECT id FROM traces WHERE project_id = ${projectId} AND external_id = ${externalTraceId}`,
    );
    if (!trace) throw new NotFoundException('Trace not found');
    const traceId = String(trace.id);

    let spanId: string | null = null;
    if (input.spanId) {
      const [span] = await rows(
        this.db,
        sql`SELECT id FROM spans WHERE trace_id = ${traceId} AND external_id = ${input.spanId}`,
      );
      if (!span) throw new NotFoundException('Span not found');
      spanId = String(span.id);
    }

    const [definition] = await this.db
      .select()
      .from(evaluationCriteria)
      .where(
        and(
          eq(evaluationCriteria.projectId, projectId),
          eq(evaluationCriteria.name, input.criterion),
        ),
      );
    if (definition) validateAgainst(definition, input);

    const values = {
      criterion: input.criterion,
      kind: input.kind,
      score: input.score ?? null,
      label: input.label ?? null,
      comment: input.comment ?? null,
    };
    const externalId = input.userId
      ? `ui:${input.userId}:${spanId ?? traceId}:${input.criterion}`
      : null;
    const insert = this.db.insert(evaluations).values({
      projectId,
      traceId,
      spanId,
      externalId,
      source: input.source,
      createdById: input.userId ?? null,
      ...values,
    });
    const [row] = externalId
      ? await insert
          .onConflictDoUpdate({
            target: [evaluations.projectId, evaluations.externalId],
            targetWhere: sql`${evaluations.externalId} IS NOT NULL`,
            set: { ...values, createdAt: new Date() },
          })
          .returning({ id: evaluations.id })
      : await insert.returning({ id: evaluations.id });

    const [created] = await rows(
      this.db,
      sql`
        SELECT v.*, s.external_id AS span_external, u.name AS user_name
        FROM evaluations v
        LEFT JOIN spans s ON s.id = v.span_id
        LEFT JOIN users u ON u.id = v.created_by_id
        WHERE v.id = ${row!.id}
      `,
    );
    return toEvaluation(created!, externalTraceId);
  }

  /** Authors can delete their own manual evaluations; admins can delete any evaluation. */
  async remove(
    projectId: string,
    id: string,
    user: { id: string; role: OrganizationRole },
  ): Promise<void> {
    const [row] = await this.db
      .select({ createdById: evaluations.createdById })
      .from(evaluations)
      .where(and(eq(evaluations.projectId, projectId), eq(evaluations.id, id)));
    if (!row) throw new NotFoundException('Evaluation not found');
    if (row.createdById !== user.id && !hasRoleAtLeast(user.role, 'admin'))
      throw new ForbiddenException('Only the author or an admin can delete this evaluation');
    await this.db.delete(evaluations).where(eq(evaluations.id, id));
  }

  async list(projectId: string, query: EvaluationsQuery): Promise<EvaluationsPage> {
    const conditions = [this.filters(projectId, query, toRange(query))];
    if (query.criterion) conditions.push(sql`v.criterion = ${query.criterion}`);
    if (query.source) conditions.push(sql`v.source = ${query.source}`);

    const result = await rows(
      this.db,
      sql`
        SELECT v.*, s.external_id AS span_external, u.name AS user_name,
               t.external_id AS trace_external, t.name AS trace_name
        FROM evaluations v
        JOIN traces t ON t.id = v.trace_id
        LEFT JOIN spans s ON s.id = v.span_id
        LEFT JOIN users u ON u.id = v.created_by_id
        WHERE ${sql.join(conditions, sql` AND `)}
              ${afterCursor(sql`v.created_at`, sql`v.id`, query.cursor)}
        ORDER BY v.created_at DESC, v.id DESC
        LIMIT ${query.limit + 1}
      `,
    );
    const { visible, nextCursor } = paginate(result, query.limit, (row) => ({
      at: row.created_at,
      id: row.id,
    }));
    return {
      items: visible.map((row) => ({
        ...toEvaluation(row, String(row.trace_external)),
        traceName: String(row.trace_name),
      })),
      nextCursor,
    };
  }

  /* ----------------------------------------------------------------- summary */

  async summary(projectId: string, query: EvaluationsQuery): Promise<EvaluationSummaryDto> {
    const range = toRange(query);
    const bucket = bucketFor(range.from.getTime(), range.to.getTime());
    const where = this.filters(projectId, query, range);
    const bucketExpr = sql`date_bin(${bucket}::interval, t.started_at AT TIME ZONE ${query.tz}, ${BUCKET_ORIGIN}::timestamp)`;
    const from = sql`${range.from.toISOString()}::timestamptz`;
    const to = sql`${range.to.toISOString()}::timestamptz`;

    const [totals, labels, series, sources, coverage, definitions] = await Promise.all([
      rows(
        this.db,
        sql`
          SELECT v.criterion, v.kind, count(*) AS count, avg(v.score) AS average,
                 count(*) FILTER (WHERE v.kind = 'thumbs' AND v.score = 1) AS positive,
                 count(*) FILTER (WHERE v.kind = 'thumbs' AND v.score = 0) AS negative
          FROM evaluations v JOIN traces t ON t.id = v.trace_id
          WHERE ${where}
          GROUP BY 1, 2
          ORDER BY count(*) DESC, v.criterion
        `,
      ),
      rows(
        this.db,
        sql`
          SELECT v.criterion, v.label, count(*) AS count
          FROM evaluations v JOIN traces t ON t.id = v.trace_id
          WHERE ${where} AND v.label IS NOT NULL
          GROUP BY 1, 2 ORDER BY 3 DESC
        `,
      ),
      rows(
        this.db,
        sql`
          WITH buckets AS (
            SELECT generate_series(
              date_bin(${bucket}::interval, ${from} AT TIME ZONE ${query.tz}, ${BUCKET_ORIGIN}::timestamp),
              (${to} - interval '1 microsecond') AT TIME ZONE ${query.tz},
              ${bucket}::interval
            ) AS b
          ),
          agg AS (
            SELECT v.criterion, ${bucketExpr} AS b, count(*) AS count, avg(v.score) AS average
            FROM evaluations v JOIN traces t ON t.id = v.trace_id
            WHERE ${where}
            GROUP BY 1, 2
          ),
          criteria AS (SELECT DISTINCT criterion FROM agg)
          SELECT c.criterion, (buckets.b AT TIME ZONE ${query.tz}) AS t,
                 coalesce(agg.count, 0) AS count, agg.average
          FROM criteria c CROSS JOIN buckets
          LEFT JOIN agg ON agg.criterion = c.criterion AND agg.b = buckets.b
          ORDER BY c.criterion, buckets.b
        `,
      ),
      rows(
        this.db,
        sql`
          SELECT v.source, count(*) AS count
          FROM evaluations v JOIN traces t ON t.id = v.trace_id
          WHERE ${where}
          GROUP BY 1 ORDER BY 2 DESC
        `,
      ),
      rows(
        this.db,
        sql`
          SELECT count(*) AS traces,
                 count(*) FILTER (WHERE EXISTS (SELECT 1 FROM evaluations v WHERE v.trace_id = t.id)) AS evaluated
          FROM traces t
          WHERE t.project_id = ${projectId} AND t.started_at >= ${from} AND t.started_at < ${to}
                ${query.environment ? sql` AND t.environment = ${query.environment}` : sql``}
        `,
      ),
      this.criteria(projectId),
    ]);

    const definitionByName = new Map(
      definitions.map((definition) => [definition.name, definition]),
    );
    const criteria: CriterionSummary[] = totals.map((row) => {
      const criterion = String(row.criterion);
      return {
        criterion,
        kind: row.kind as EvaluationKind,
        count: num(row.count),
        average: floatOrNull(row.average),
        positive: num(row.positive),
        negative: num(row.negative),
        labels: labels
          .filter((label) => label.criterion === criterion)
          .map((label) => ({ label: String(label.label), count: num(label.count) })),
        definition: definitionByName.get(criterion) ?? null,
        series: series
          .filter((point) => point.criterion === criterion)
          .map((point) => ({
            t: iso(point.t),
            count: num(point.count),
            average: floatOrNull(point.average),
          })),
      };
    });
    // Defined criteria without scores yet still appear, so the page can offer them.
    for (const definition of definitions) {
      if (criteria.some((entry) => entry.criterion === definition.name)) continue;
      criteria.push({
        criterion: definition.name,
        kind: definition.kind,
        count: 0,
        average: null,
        positive: 0,
        negative: 0,
        labels: [],
        definition,
        series: [],
      });
    }

    const traceCount = num(coverage[0]?.traces);
    return {
      bucket,
      total: criteria.reduce((sum, entry) => sum + entry.count, 0),
      bySource: sources.map((row) => ({
        source: row.source as EvaluationSource,
        count: num(row.count),
      })),
      coverage: traceCount === 0 ? 0 : num(coverage[0]?.evaluated) / traceCount,
      criteria,
    };
  }

  /**
   * Evaluations of traces that started in the range (quality is attributed to when the response
   * was produced, not when feedback arrived), with the usual trace filters.
   */
  private filters(projectId: string, query: EvaluationsQuery, range: Range): SQL {
    const conditions: SQL[] = [
      sql`v.project_id = ${projectId}`,
      sql`t.started_at >= ${range.from.toISOString()}::timestamptz`,
      sql`t.started_at < ${range.to.toISOString()}::timestamptz`,
    ];
    if (query.environment) conditions.push(sql`t.environment = ${query.environment}`);
    if (query.provider || query.model) {
      const model: SQL[] = [sql`s.trace_id = v.trace_id`, sql`s.kind = 'llm'`];
      if (query.provider) model.push(sql`s.provider_id = ${query.provider}`);
      if (query.model) model.push(sql`s.model = ${query.model}`);
      conditions.push(sql`EXISTS (SELECT 1 FROM spans s WHERE ${sql.join(model, sql` AND `)})`);
    }
    return sql.join(conditions, sql` AND `);
  }
}

/* ------------------------------------------------------------------ helpers */

function criterionValues(input: CriterionInput) {
  return {
    name: input.name,
    description: input.description ?? null,
    kind: input.kind,
    minScore: input.kind === 'numeric' ? (input.minScore ?? null) : null,
    maxScore: input.kind === 'numeric' ? (input.maxScore ?? null) : null,
    labels: input.kind === 'categorical' ? (input.labels ?? []) : [],
  };
}

function toCriterion(row: CriterionRow): CriterionDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    kind: row.kind,
    minScore: row.minScore,
    maxScore: row.maxScore,
    labels: row.labels,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Rejects scores that do not fit a defined criterion (wrong kind, out of scale, unknown label). */
export function validateAgainst(
  definition: Pick<CriterionRow, 'name' | 'kind' | 'minScore' | 'maxScore' | 'labels'>,
  input: Pick<CreateEvaluationInput, 'kind' | 'score' | 'label'>,
): void {
  if (definition.kind !== input.kind)
    throw new BadRequestException(
      `Criterion "${definition.name}" expects ${definition.kind} evaluations`,
    );
  if (definition.kind === 'numeric' && input.score !== undefined) {
    const min = definition.minScore ?? Number.NEGATIVE_INFINITY;
    const max = definition.maxScore ?? Number.POSITIVE_INFINITY;
    if (input.score < min || input.score > max)
      throw new BadRequestException(
        `Score must be between ${definition.minScore} and ${definition.maxScore}`,
      );
  }
  if (definition.kind === 'categorical' && !definition.labels.includes(input.label ?? ''))
    throw new BadRequestException(`Label must be one of: ${definition.labels.join(', ')}`);
}
