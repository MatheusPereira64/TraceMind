# ADR-002: Drizzle ORM and SQL-first migrations

- Status: accepted
- Date: 2026-11-05

## Context

The workload is analytics-heavy: percentiles, time bucketing, JSONB filtering and large time-range
scans. We need typed queries for CRUD, but full control over SQL for analytics, plus reviewable
migrations. Prisma and TypeORM were considered.

## Decision

Use **Drizzle ORM** with `node-postgres` and **drizzle-kit** for migrations.

- Schema is TypeScript (`apps/api/src/database/schema.ts`); `drizzle-kit generate` emits plain SQL into
  `apps/api/drizzle/`, which is reviewed and committed. Reference data (providers) uses custom SQL migrations.
- Migrations run through a small runner (`src/database/migrate.ts`) used by `pnpm db:migrate`, the
  `migrate` container and the integration tests — one code path everywhere.
- Analytics queries use Drizzle's `sql` template where the query builder is not expressive enough.

## Alternatives

- **Prisma 7**: excellent DX, but requires a separate engine binary download at install/generate time
  (a problem in restricted CI/air-gapped builds) and pushes complex analytics to `$queryRaw` without types.
- **TypeORM**: decorator entities fit Nest, but migrations and typing of raw queries are weaker.

## Consequences

- No binary engine in the image; the API container only needs `node_modules` with pure JS drivers.
- Relational query API (`db.query.*`) is used for simple reads; joins are explicit.
- Team members must review generated SQL — intentional, since indexes matter for this workload.
