/** Environment for integration tests. Runs in every test worker before specs are imported. */
export const TEST_DATABASE_URL =
  process.env.DATABASE_URL_TEST ?? 'postgres://tracemind:tracemind@localhost:5432/tracemind_test';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-0123';
process.env.LOG_LEVEL = 'silent';
process.env.WEB_ORIGIN = 'http://localhost:3000';
process.env.RATE_LIMIT_PER_MINUTE = '10000';
process.env.AUTH_RATE_LIMIT_PER_MINUTE = '1000';
process.env.INGESTION_RETRY_DELAY_MS = '20';
process.env.INGEST_RATE_LIMIT_PER_MINUTE = '10000';
