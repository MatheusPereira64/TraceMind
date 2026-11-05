/**
 * Public URL where instrumented applications reach the ingestion API. Shown in setup snippets.
 * NEXT_PUBLIC_* values are inlined at build time.
 */
export const PUBLIC_API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(
  /\/$/,
  '',
);
