# ADR-001: pnpm monorepo with a shared contracts package

- Status: accepted
- Date: 2026-11-05

## Context

TraceMind has an API, a dashboard and (from Phase 2) an SDK that must agree on the same shapes:
enum values stored in PostgreSQL, request validation rules and response DTOs. Divergence between
them is the most common source of integration bugs in this kind of system.

## Decision

- One repository with pnpm workspaces: `apps/api`, `apps/web`, `packages/shared` (later `packages/sdk`).
- `@tracemind/shared` holds enums, Zod schemas and DTO interfaces. The API validates request bodies
  with these schemas (`ZodValidationPipe`) instead of class-validator DTOs, and the dashboard uses the
  same types for its forms and queries. Database enums are generated from the same constants.
- The shared package is compiled to ESM (`dist/`) so the Nest runtime consumes plain JavaScript; Next.js
  transpiles it through `transpilePackages`.

## Consequences

- A rule change (e.g. password length) is made once and enforced everywhere.
- Zod schemas do not generate Swagger annotations automatically; an OpenAPI document will be produced
  from the schemas with `z.toJSONSchema` in Phase 5.
- `pnpm build` must build `packages/*` before `apps/*` (encoded in the root scripts and Dockerfiles).
- Turborepo/Nx were not adopted: with three packages, pnpm filters are enough. Revisit if build times grow.
