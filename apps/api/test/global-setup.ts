import pg from 'pg';
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
      'TRUNCATE users, organizations, projects, api_keys, traces, ingestion_failures RESTART IDENTITY CASCADE',
    );
  } finally {
    await pool.end();
  }
}
