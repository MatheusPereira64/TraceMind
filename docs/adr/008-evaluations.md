# ADR-008: Evaluations — one table for every source, optional criteria

- Status: accepted
- Date: 2026-11-08

## Context

Quality signals come from different places: end users (thumbs from the product), the application's
own checks (sent with the SDK), reviewers in the dashboard and, later, LLM-as-a-Judge. Teams also
invent criteria as they go (`helpfulness`, `resolution`, `tone`), and an observability tool that
requires defining every criterion up front loses data the first time a new name is sent.

## Decision

- **One `evaluations` table for every source** (`human`, `api`, `llm_judge`), linked to a trace and
  optionally a span. Charts, filters and the trace view work the same for all sources.
- **Criteria are optional definitions.** `evaluation_criteria` adds a description, the kind, a
  numeric scale or allowed labels. Scores sent with an undefined name are still stored and charted;
  manual scores against a defined criterion are validated (kind, scale bounds, label list). The name
  and kind of a definition are immutable because recorded scores depend on them; deleting a
  definition keeps the scores.
- **Reviewer scores are idempotent per user, target and criterion** (`external_id =
ui:<user>:<span or trace>:<criterion>`), so clicking 👍 then 👎 replaces the vote instead of
  counting twice. SDK scores keep their own idempotency keys.
- **Quality is attributed to the trace start time**, not to when feedback arrived. "Quality last
  Tuesday" then means the answers produced on Tuesday — which lines up with deploys, model changes
  and incidents in the other dashboards.
- **Automated evaluators implement one interface** (`apps/api/src/evaluations/evaluator.ts`):
  given a span, return a score/label/comment for a criterion. An LLM-as-a-Judge runner will be a
  BullMQ job that selects unevaluated LLM spans (optionally sampled), calls the evaluator and records
  results with `source = llm_judge` through the same service path as reviewer scores.

## Consequences

- No migration or configuration is needed to start sending scores; definitions improve them later.
- Averages are only meaningful per criterion (scales differ), so the summary never mixes criteria.
- Feedback that arrives days later moves a past data point instead of the current one; this is the
  intended reading, documented in the dashboard copy.
