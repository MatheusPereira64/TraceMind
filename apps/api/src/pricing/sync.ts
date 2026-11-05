/**
 * `pnpm pricing:sync` — loads pricing/models.json into model_pricing and recomputes estimated
 * costs. Idempotent; also run by the `migrate` container after migrations.
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { recomputeCosts, upsertPrices } from './pricing-sync.js';
import { parseRegistry } from './registry.js';

/** Works from src/pricing (tsx) and dist/pricing (compiled). */
export const REGISTRY_PATH = fileURLToPath(new URL('../../pricing/models.json', import.meta.url));

async function main(): Promise<void> {
  const envFile = new URL('../../.env', import.meta.url);
  if (process.env.NODE_ENV !== 'production' && existsSync(envFile)) process.loadEnvFile(envFile);
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');

  const rows = parseRegistry(JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')));
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    const db = drizzle(pool);
    const upserted = await upsertPrices(db, rows);
    const recomputed = await recomputeCosts(db);
    console.log(
      `Pricing synced: ${upserted} price rows, ${recomputed} token usage rows recomputed`,
    );
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error('Pricing sync failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
