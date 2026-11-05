# TraceMind

**Observability for LLM applications** — trace every model call from prompt to response and see what it
costs, how long it takes, where it fails and how good the answers are.

TraceMind is a full-stack platform: a NestJS ingestion and analytics API, a Next.js dashboard, a
TypeScript SDK and OpenTelemetry support, backed by PostgreSQL and Redis.

> **Status:** Phase 1 (foundation) is complete — authentication, multi-tenant organizations, projects,
> API keys, database schema for all telemetry, Docker environment and CI. Telemetry ingestion and the
> SDK are next. See the [delivery plan](docs/ARCHITECTURE.md#8-delivery-plan).

## Stack

| Layer     | Technology                                                                                  |
| --------- | ------------------------------------------------------------------------------------------- |
| Dashboard | Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS 4, TanStack Query               |
| API       | Node.js 22, NestJS 12 (ESM), Zod, pino                                                      |
| Data      | PostgreSQL 17 (Drizzle ORM + SQL migrations), Redis 7                                       |
| Telemetry | OpenTelemetry Collector (OTLP gRPC/HTTP)                                                    |
| Tooling   | pnpm workspaces, Vitest, Supertest, Testing Library, oxlint, Docker Compose, GitHub Actions |

## Quick start (Docker)

```bash
cp .env.example .env
# set POSTGRES_PASSWORD and JWT_SECRET (openssl rand -base64 48)
docker compose up --build
```

Open <http://localhost:3000>, create an account, create a project and generate an API key. Verify the key:

```bash
curl http://localhost:4000/v1/ingest/whoami -H "Authorization: Bearer tm_dev_…"
```

## Local development

Requires Node.js 22+ and pnpm 10 (`corepack enable`).

```bash
docker compose -f docker-compose.dev.yml up -d     # Postgres, Redis, OTel Collector
pnpm install
cp apps/api/.env.example apps/api/.env              # set JWT_SECRET
cp apps/web/.env.example apps/web/.env.local
pnpm db:migrate
pnpm dev                                            # API :4000 (watch) + dashboard :3000
```

| Command                                 | What it does                                                              |
| --------------------------------------- | ------------------------------------------------------------------------- |
| `pnpm test`                             | Unit and component tests for all packages                                 |
| `pnpm --filter @tracemind/api test:e2e` | API integration tests against real Postgres + Redis (`tracemind_test`)    |
| `pnpm typecheck` / `pnpm lint`          | Type checking and linting across the workspace                            |
| `pnpm db:generate`                      | Generate a SQL migration after changing `apps/api/src/database/schema.ts` |
| `pnpm build`                            | Production build of every package                                         |

## Repository layout

```
apps/api          NestJS API — auth, tenancy, API keys, (next) ingestion and analytics
apps/web          Next.js dashboard
packages/shared   Enums, Zod schemas and API contracts shared by API, dashboard and SDK
infrastructure    OpenTelemetry Collector and Postgres init config
docs              Architecture, API contracts and decision records
```

## Design highlights

- **Raw telemetry is the source of truth.** Every trace and span is preserved; costs and percentiles are
  computed from it, so numbers can be recomputed and audited ([ADR-005](docs/adr/005-telemetry-storage.md)).
- **Versioned model pricing.** Costs resolve against the price valid when the call happened; estimated
  and provider-reported costs are kept apart.
- **Tenant isolation by construction.** Every telemetry row carries `project_id`; every route passes an
  access check that answers 404 to outsiders and 403 to insufficient roles.
- **Separate credentials for people and machines.** httpOnly session cookies for the dashboard,
  SHA-256-hashed, environment-tagged API keys for telemetry ([ADR-003](docs/adr/003-authentication.md)).
- **One contract, enforced twice.** The same Zod schemas validate input in the API and the dashboard.

Read the full [architecture document](docs/ARCHITECTURE.md).
