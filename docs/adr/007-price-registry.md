# ADR-007: Model price registry as versioned data

- Status: accepted
- Date: 2026-11-05

## Context

Cost is the metric people trust least when it cannot be explained. LLM prices change often (new
models, promotional windows, announced increases), differ per provider in structure (cached input,
cache writes, long-prompt tiers) and must never silently rewrite historical spend.

## Decision

- Prices live in `apps/api/pricing/models.json`: provider, model, USD per 1M input / cached input /
  output tokens, an optional `[effectiveFrom, effectiveTo)` window, and the official source URL.
  The file records the date the prices were verified. Changing a price is a data change reviewed in
  a pull request, not a code change.
- `pricing:sync` validates the file (decimal precision, no overlapping windows per model), upserts
  rows keyed by `(provider, model, effective_from)` and never deletes, then recomputes estimates in
  one set-based SQL statement. The same statement runs in the `migrate` container on every deploy.
- A row without `effectiveFrom` applies to all usage before the first dated change. This is stated
  explicitly because the registry does not track price history before it was first verified.
- Estimates use the row valid at each span's start; `token_usage.pricing_id` records which row.
  Provider-reported cost is stored separately and shown next to the estimate.
- Not modelled yet: cache-write surcharges, long-prompt tiers (e.g. Claude Haiku 5.5 above 100K
  input tokens), batch discounts and non-text modalities. These are documented on the affected rows.

## Consequences

- Historical costs are reproducible and auditable; a price correction is one sync away.
- Prices go stale unless someone updates the file; the dashboard shows each row's source and
  validity, and flags usage of models with no price as "unpriced" rather than $0.
- An admin UI for prices was deferred: prices are global across tenants, so editing them belongs to
  operators, not organization admins.
