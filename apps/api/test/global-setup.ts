import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import pg from 'pg';
import { INGESTION_QUEUE } from '../src/ingestion/ingestion.types.js';
import { runMigrations } from '../src/database/migrate.js';

const url =
  process.env.DATABASE_URL_TEST ?? 'postgres://tracemind:tracemind@localhost:5432/tracemind_test';

/** Applies migrations to the test database once per run. */
export default async function setup(): Promise<void> {
  if (!/test/i.test(new URL(url).pathname)) {
    throw new Error(`Refusing to run integration tests against a non-test database: ${url}`);
  }
  await runMigrations(url);

  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    await pool.query(
      'TRUNCATE users, organizations, projects, api_keys, traces, ingestion_failures, model_pricing RESTART IDENTITY CASCADE',
    );
  } finally {
    await pool.end();
  }

  // Jobs left by a previous run would reference projects that no longer exist.
  const connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
  });
  const queue = new Queue(INGESTION_QUEUE, { connection });
  try {
    await queue.obliterate({ force: true });
  } finally {
    await queue.close();
    await connection.quit();
  }
}
