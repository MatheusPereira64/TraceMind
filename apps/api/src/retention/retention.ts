import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

type Db = NodePgDatabase<Record<string, unknown>>;

const DAY_MS = 86_400_000;

/** Dead-letter rows without a project (e.g. the project was unknown) use this window. */
export const ORPHAN_FAILURE_RETENTION_DAYS = 30;

export interface RetentionOptions {
  /** Reference time; telemetry that started before `now - retention_days` is removed. */
  now?: Date;
  /** Rows deleted per statement. Small batches keep locks and WAL bursts short. */
  batchSize?: number;
  /** Restrict the run to one project (used by tests and manual runs). */
  projectId?: string;
}

export interface ProjectRetentionResult {
  projectId: string;
  retentionDays: number;
  cutoff: string;
  traces: number;
  ingestionFailures: number;
}

export interface RetentionResult {
  startedAt: string;
  durationMs: number;
  traces: number;
  ingestionFailures: number;
  /** Only projects where something was deleted. */
  projects: ProjectRetentionResult[];
}

/**
 * Deletes raw telemetry older than each project's `retention_days`.
 *
 * The unit of retention is the trace: a trace whose `started_at` is before the cutoff is deleted
 * together with its spans, token usage, errors and evaluations (ON DELETE CASCADE), so a trace is
 * never left partially deleted. Rows are removed in bounded batches through the
 * `(project_id, started_at)` index, and every statement is idempotent: an interrupted or
 * concurrent run converges to the same state.
 *
 * Archived projects are included: their data stays readable until retention removes it.
 */
export async function purgeExpiredTelemetry(
  db: Db,
  options: RetentionOptions = {},
): Promise<RetentionResult> {
  const startedAt = Date.now();
  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? 1_000;
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error('batchSize must be a positive integer');
  }

  const { rows: projectRows } = await db.execute<{ id: string; retention_days: number }>(
    options.projectId
      ? sql`SELECT id, retention_days FROM projects WHERE id = ${options.projectId}`
      : sql`SELECT id, retention_days FROM projects ORDER BY id`,
  );

  const projects: ProjectRetentionResult[] = [];
  for (const project of projectRows) {
    const cutoff = new Date(now.getTime() - project.retention_days * DAY_MS);
    const traces = await deleteInBatches(
      db,
      (limit) => sql`
        DELETE FROM traces WHERE id IN (
          SELECT id FROM traces
          WHERE project_id = ${project.id} AND started_at < ${cutoff.toISOString()}
          ORDER BY started_at
          LIMIT ${limit}
        )`,
      batchSize,
    );
    const ingestionFailures = await deleteInBatches(
      db,
      (limit) => sql`
        DELETE FROM ingestion_failures WHERE id IN (
          SELECT id FROM ingestion_failures
          WHERE project_id = ${project.id} AND created_at < ${cutoff.toISOString()}
          ORDER BY created_at
          LIMIT ${limit}
        )`,
      batchSize,
    );
    if (traces > 0 || ingestionFailures > 0) {
      projects.push({
        projectId: project.id,
        retentionDays: project.retention_days,
        cutoff: cutoff.toISOString(),
        traces,
        ingestionFailures,
      });
    }
  }

  let orphanFailures = 0;
  if (!options.projectId) {
    const cutoff = new Date(now.getTime() - ORPHAN_FAILURE_RETENTION_DAYS * DAY_MS);
    orphanFailures = await deleteInBatches(
      db,
      (limit) => sql`
        DELETE FROM ingestion_failures WHERE id IN (
          SELECT id FROM ingestion_failures
          WHERE project_id IS NULL AND created_at < ${cutoff.toISOString()}
          ORDER BY created_at
          LIMIT ${limit}
        )`,
      batchSize,
    );
  }

  return {
    startedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    traces: projects.reduce((sum, project) => sum + project.traces, 0),
    ingestionFailures:
      projects.reduce((sum, project) => sum + project.ingestionFailures, 0) + orphanFailures,
    projects,
  };
}

/** Repeats a bounded DELETE until it removes fewer rows than the batch size. */
async function deleteInBatches(
  db: Db,
  statement: (limit: number) => ReturnType<typeof sql>,
  batchSize: number,
): Promise<number> {
  let total = 0;
  for (;;) {
    const result = await db.execute(statement(batchSize));
    const deleted = result.rowCount ?? 0;
    total += deleted;
    if (deleted < batchSize) return total;
  }
}
