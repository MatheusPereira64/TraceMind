import { z } from 'zod';

const booleanFromString = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),

  /** HS256 signing secret for dashboard session tokens. */
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must have at least 32 characters'),
  JWT_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(300)
    .max(60 * 60 * 24 * 30)
    .default(60 * 60 * 12),

  /** Exact origin(s) of the dashboard, comma separated. Used for CORS with credentials. */
  WEB_ORIGIN: z
    .string()
    .default('http://localhost:3000')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),
  /** Set to true when the API runs behind a reverse proxy, so client IPs are read correctly. */
  TRUST_PROXY: booleanFromString.default(false),
  /** Secure cookies require HTTPS; defaults to true in production. */
  COOKIE_SECURE: booleanFromString.optional(),

  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(300),
  /** Seconds analytics responses are cached in Redis (0 disables). */
  ANALYTICS_CACHE_TTL_SECONDS: z.coerce.number().int().min(0).max(3600).default(15),
  /** Per API key. Each request may carry up to 1000 events. */
  INGEST_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(600),

  /** Run the ingestion worker in this process. Disable to run API-only replicas. */
  INGESTION_WORKER_ENABLED: booleanFromString.default(true),
  INGESTION_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
  /** Base delay of the exponential retry backoff (6 attempts: ≈2s, 4s, 8s, 16s, 32s). */
  INGESTION_RETRY_DELAY_MS: z.coerce.number().int().min(1).default(2_000),
  /** Back-pressure: above this many waiting batches, ingestion answers 503 + Retry-After. */
  INGESTION_MAX_QUEUED_BATCHES: z.coerce.number().int().min(10).default(10_000),
  AUTH_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(10),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  return result.data;
}

export const ENV = Symbol('ENV');
