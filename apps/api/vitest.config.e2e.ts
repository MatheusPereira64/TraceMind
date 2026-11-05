import { defineConfig } from 'vitest/config';

/**
 * Integration tests run against a real PostgreSQL database (DATABASE_URL_TEST, falling back to
 * DATABASE_URL) and Redis. The global setup applies migrations and truncates tables.
 */
export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.e2e-spec.ts'],
    globalSetup: ['./test/global-setup.ts'],
    setupFiles: ['./test/setup-env.ts'],
    // Specs share one database; run files sequentially to keep them isolated.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
