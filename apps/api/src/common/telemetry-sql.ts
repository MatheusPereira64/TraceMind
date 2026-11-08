import type { AnalyticsQuery } from '@tracemind/shared';
import { sql, type SQL } from 'drizzle-orm';
import type { Database } from '../database/database.module.js';

/** Helpers shared by the read-side services (analytics, trace explorer, evaluations). */

export type Row = Record<string, unknown>;

export interface Range {
  from: Date;
  to: Date;
}

export const toRange = (query: Pick<AnalyticsQuery, 'from' | 'to'>): Range => ({
  from: new Date(query.from),
  to: new Date(query.to),
});

export const num = (value: unknown): number =>
  value === null || value === undefined ? 0 : Number(value);
export const numOrNull = (value: unknown): number | null =>
  value === null || value === undefined ? null : Math.round(Number(value));
export const floatOrNull = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);
export const iso = (value: unknown): string => new Date(value as string | Date).toISOString();
export const isoOrNull = (value: unknown): string | null =>
  value === null || value === undefined ? null : iso(value);
export const strOrNull = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);

export async function rows(db: Database, query: SQL): Promise<Row[]> {
  const result = await db.execute(query);
  return result.rows as Row[];
}

/**
 * WHERE clause for LLM calls (`s` = spans, `t` = traces) in a project, time range and the common
 * environment/provider/model filters.
 */
export function llmSpanFilters(projectId: string, query: AnalyticsQuery, range: Range): SQL {
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

/** Full-text query: websearch syntax ("quoted phrase", -exclude, or), no stemming or stop words. */
export const tsQuery = (q: string): SQL => sql`websearch_to_tsquery('simple', ${q})`;

/* ------------------------------------------------------------- keyset cursors */

/** Opaque cursor for (timestamp DESC, uuid DESC) keyset pagination. */
export function encodeCursor(at: string, id: string): string {
  return Buffer.from(`${at}|${id}`, 'utf8').toString('base64url');
}

/** Returns null for missing or malformed cursors (the first page is served instead). */
export function decodeCursor(cursor: string | undefined): { at: string; id: string } | null {
  if (!cursor) return null;
  const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (!at || !id || Number.isNaN(Date.parse(at)) || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  return { at, id };
}

/** `(column, id) < cursor` condition, or an empty fragment for the first page. */
export function afterCursor(column: SQL, idColumn: SQL, cursor: string | undefined): SQL {
  const decoded = decodeCursor(cursor);
  return decoded
    ? sql` AND (${column}, ${idColumn}) < (${decoded.at}::timestamptz, ${decoded.id}::uuid)`
    : sql``;
}

/** Splits a `limit + 1` result into the visible page and the next cursor. */
export function paginate<T extends Row>(
  result: T[],
  limit: number,
  key: (row: T) => { at: unknown; id: unknown },
): { visible: T[]; nextCursor: string | null } {
  const visible = result.slice(0, limit);
  const last = visible.at(-1);
  if (result.length <= limit || !last) return { visible, nextCursor: null };
  const { at, id } = key(last);
  return { visible, nextCursor: encodeCursor(iso(at), String(id)) };
}
