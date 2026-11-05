import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { modelPricing, modelProviders } from '../database/schema.js';
import { UNDATED_MODEL_SQL_PATTERN, type PriceRowInput } from './registry.js';

type Db = NodePgDatabase<Record<string, unknown>>;

/** Upserts registry rows (never deletes: past windows keep historical costs reproducible). */
export async function upsertPrices(db: Db, rows: PriceRowInput[]): Promise<number> {
  return db.transaction(async (tx) => {
    const providers = [...new Set(rows.map((row) => row.providerId))];
    await tx
      .insert(modelProviders)
      .values(providers.map((id) => ({ id, displayName: id })))
      .onConflictDoNothing({ target: modelProviders.id });

    for (const row of rows) {
      await tx
        .insert(modelPricing)
        .values(row)
        .onConflictDoUpdate({
          target: [modelPricing.providerId, modelPricing.model, modelPricing.effectiveFrom],
          set: {
            inputPricePerMillion: row.inputPricePerMillion,
            outputPricePerMillion: row.outputPricePerMillion,
            cachedInputPricePerMillion: row.cachedInputPricePerMillion,
            effectiveTo: row.effectiveTo,
            source: row.source,
          },
        });
    }
    return rows.length;
  });
}

/**
 * Recomputes estimated costs from the price valid at each span's start, in one set-based UPDATE.
 * Mirrors estimateCostUsd (exact NUMERIC arithmetic, rounded half-up to 8 places) and the
 * dated-snapshot alias rule. Only rows whose price or cost actually changes are written.
 */
export async function recomputeCosts(
  db: Db,
  options: { projectId?: string } = {},
): Promise<number> {
  const result = await db.execute(sql`
    WITH resolved AS (
      SELECT u.span_id, p.id AS pricing_id,
             ROUND(
               ((u.input_tokens - u.cached_input_tokens) * p.input_price_per_million
                + u.cached_input_tokens * COALESCE(p.cached_input_price_per_million, p.input_price_per_million)
                + u.output_tokens * p.output_price_per_million) / 1000000.0,
               8) AS cost
      FROM token_usage u
      JOIN spans s ON s.id = u.span_id
      JOIN LATERAL (
        SELECT mp.*
        FROM model_pricing mp
        WHERE mp.provider_id = s.provider_id
          AND mp.model IN (s.model, regexp_replace(s.model, ${UNDATED_MODEL_SQL_PATTERN}, ''))
          AND mp.effective_from <= s.started_at
          AND (mp.effective_to IS NULL OR mp.effective_to > s.started_at)
        ORDER BY (mp.model = s.model) DESC, mp.effective_from DESC
        LIMIT 1
      ) p ON TRUE
      WHERE s.provider_id IS NOT NULL AND s.model IS NOT NULL
        ${options.projectId ? sql`AND u.project_id = ${options.projectId}` : sql``}
    )
    UPDATE token_usage u
    SET pricing_id = r.pricing_id, estimated_cost_usd = r.cost
    FROM resolved r
    WHERE u.span_id = r.span_id
      AND (u.pricing_id IS DISTINCT FROM r.pricing_id OR u.estimated_cost_usd IS DISTINCT FROM r.cost)
  `);
  return result.rowCount ?? 0;
}
