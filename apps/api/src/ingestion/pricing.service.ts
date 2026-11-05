import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { DATABASE, type Database } from '../database/database.module.js';
import { modelPricing, type ModelPricing } from '../database/schema.js';
import { undatedModel } from '../pricing/registry.js';

const CACHE_TTL_MS = 60_000;

/**
 * Resolves the price valid for a (provider, model) at a point in time. Price lists are small and
 * change rarely, so each model's rows are cached briefly in memory.
 */
@Injectable()
export class PricingService {
  private readonly cache = new Map<string, { rows: ModelPricing[]; expiresAt: number }>();

  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * Exact model name first; dated snapshots (`gpt-4.1-2025-04-14`) fall back to their alias.
   * Keep in sync with recomputeCosts (pricing-sync.ts).
   */
  async priceAt(providerId: string, model: string, at: Date): Promise<ModelPricing | null> {
    const exact = await this.priceAtExact(providerId, model, at);
    if (exact) return exact;
    const alias = undatedModel(model);
    return alias ? this.priceAtExact(providerId, alias, at) : null;
  }

  private async priceAtExact(
    providerId: string,
    model: string,
    at: Date,
  ): Promise<ModelPricing | null> {
    const rows = await this.rowsFor(providerId, model);
    const time = at.getTime();
    // Rows are ordered by effective_from DESC: the first window containing `at` wins.
    return (
      rows.find(
        (row) =>
          row.effectiveFrom.getTime() <= time &&
          (row.effectiveTo === null || row.effectiveTo.getTime() > time),
      ) ?? null
    );
  }

  invalidate(): void {
    this.cache.clear();
  }

  private async rowsFor(providerId: string, model: string): Promise<ModelPricing[]> {
    const key = `${providerId}\u0000${model}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.rows;

    const rows = await this.db
      .select()
      .from(modelPricing)
      .where(and(eq(modelPricing.providerId, providerId), eq(modelPricing.model, model)))
      .orderBy(desc(modelPricing.effectiveFrom));
    this.cache.set(key, { rows, expiresAt: Date.now() + CACHE_TTL_MS });
    return rows;
  }
}
