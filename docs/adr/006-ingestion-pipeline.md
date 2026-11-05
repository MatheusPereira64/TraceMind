# ADR-006: Asynchronous, idempotent ingestion pipeline

- Status: accepted
- Date: 2026-11-05

## Context

Instrumented applications send telemetry from their hot path. Ingestion must answer fast, never lose
accepted data, tolerate retries and out-of-order delivery, and keep secrets out of storage.

## Decision

```
SDK / OTel Collector ──HTTP──▶ API (validate · redact · enqueue) ──▶ Redis (BullMQ) ──▶ worker (upsert) ──▶ PostgreSQL
                                     │ 202 + per-event rejections                          │ after 6 attempts
                                     └────────────▶ ingestion_failures ◀───────────────────┘
```

1. **Per-event validation.** The envelope is validated loosely; each event is validated on its own
   against the shared Zod schema. Valid events are accepted even if others in the batch are not, and
   the response lists every rejection by index. Rejections are stored in `ingestion_failures`.
2. **Redaction before enqueueing.** Masking runs in the request handler, so raw secrets never reach
   Redis (whose persistence may write them to disk) or PostgreSQL. Built-in detectors use bounded,
   linear-time patterns; projects can add exact _literal_ terms but not regular expressions, which
   rules out ReDoS from user-supplied patterns.
3. **Queue.** One BullMQ job per accepted batch, 6 attempts with exponential backoff. Data errors
   (PostgreSQL class 22, check violations) fail fast as unrecoverable. Exhausted jobs are written to
   `ingestion_failures` with the (redacted, size-bounded) payload. Back-pressure: above
   `INGESTION_MAX_QUEUED_BATCHES` the endpoint answers `503`, which the SDK retries.
4. **Idempotent upserts.** Each batch is one transaction. Traces upsert on `(project_id, external_id)`,
   spans on `(trace_id, external_id)`, token usage on `span_id`, errors on `span_id` (or trace for
   trace-level errors), evaluations on `(project_id, external_id)` when an id is given. Omitted fields
   never clear stored ones, so "span started" and "span ended" can be separate events.
5. **Out-of-order tolerance.** A span whose trace has not arrived creates a placeholder trace
   (`is_complete = false`) that the trace event later completes. Parents are linked by
   `parent_external_id` and resolved whenever either side arrives. Evaluations that reference a span
   not yet stored are retried by the queue.
6. **Cost at ingestion.** The estimate uses the `model_pricing` row valid at the span's start, with
   integer arithmetic (`cost.ts`); `pricing_id` records which row was used.
7. **Rate limiting per API key**, not per IP, and separate from the dashboard limit.
8. **OTLP/HTTP JSON** is mapped to the same events (GenAI semantic conventions), so both paths share
   validation, redaction and persistence.

## Consequences

- Telemetry appears with a small delay (typically < 1 s) instead of synchronously.
- Throughput scales by running more worker processes (`INGESTION_WORKER_ENABLED=false` on API-only
  replicas). Upserts on the same trace from concurrent batches are serialized by row locks.
- Protobuf OTLP is not supported yet; collectors must use `encoding: json`.
- Redaction setting changes take up to 30 s to apply (per-process cache).
