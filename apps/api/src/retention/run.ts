/**
 * `pnpm retention:run [--project <uuid>] [--batch-size <n>]` — runs the retention job once,
 * outside the API's schedule (e.g. from a system cron, or after lowering a project's retention).
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { purgeExpiredTelemetry } from './retention.js';

async function main(): Promise<void> {
  const envFile = new URL('../../.env', import.meta.url);
  if (process.env.NODE_ENV !== 'production' && existsSync(envFile)) process.loadEnvFile(envFile);
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');

  const { values } = parseArgs({
    options: {
      project: { type: 'string' },
      'batch-size': { type: 'string' },
    },
  });
  const batchSize = values['batch-size'] ? Number(values['batch-size']) : undefined;

  const pool = new pg.Pool({
    connectionString: url,
    max: 1,
    application_name: 'tracemind-retention',
  });
  try {
    const result = await purgeExpiredTelemetry(drizzle(pool), {
      ...(values.project ? { projectId: values.project } : {}),
      ...(batchSize === undefined ? {} : { batchSize }),
    });
    console.log(
      `Retention: ${result.traces} traces and ${result.ingestionFailures} ingestion failures deleted ` +
        `across ${result.projects.length} project(s) in ${result.durationMs} ms`,
    );
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error('Retention failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
