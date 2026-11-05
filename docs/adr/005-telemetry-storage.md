# ADR-005: Preserve raw telemetry, version prices, defer partitioning

- Status: accepted
- Date: 2026-11-05

## Context

Observability numbers are only trustworthy if they can be traced back to the requests that produced
them. LLM prices change frequently, and the metrics people want evolve after data is collected.

## Decision

1. **Raw first.** Traces, spans, token usage, errors and evaluations are stored individually. Aggregates
   are computed at query time (optionally cached in Redis), never stored as the only copy.
2. **Versioned pricing.** `model_pricing` rows have `[effective_from, effective_to)`. A span's estimated
   cost uses the price valid at the span's start, and `token_usage.pricing_id` records which row was
   used. Provider-reported cost is stored separately and never overwritten by estimates.
3. **Denormalized tenant key.** Every telemetry table has `project_id` with composite indexes led by
   it, so isolation and time-range scans never require joins.
4. **Idempotency.** `(project_id, external_id)` on traces and `(trace_id, external_id)` on spans make
   retries safe.
5. **Partitioning deferred.** Monthly range partitioning of `traces`/`spans` is the planned path if
   volume demands it; it is not applied now to avoid operational complexity before it is justified.

## Consequences

- Price corrections are a data operation (`UPDATE token_usage … FROM model_pricing`), not a migration.
- Storage grows with traffic; per-project `retention_days` and the Phase 5 retention job bound it.
- Analytics queries must be written carefully against indexes; Phase 3 includes query plans in review.
