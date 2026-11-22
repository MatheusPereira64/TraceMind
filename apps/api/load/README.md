# Ingestion load test

`ingest-load.ts` measures the telemetry ingestion path end to end. It creates a throwaway account,
project and API key on the target API, sends `POST /v1/ingest/batch` requests with
[autocannon](https://github.com/mcollina/autocannon) and waits until the queue workers have written
everything that was accepted to PostgreSQL. It reports two numbers that matter for different
reasons:

- **Acceptance:** HTTP throughput and latency of the ingestion endpoint (validation, redaction,
  enqueue). This is what an instrumented application waits on.
- **Persistence:** events written per second by the workers, and how long the queue needs to drain
  after the load stops. This is how long it takes before data shows up in the dashboard.

## Running it

The target API needs a per-key limit above the default 600 requests/minute:

```bash
# API under test (production build)
pnpm --filter @tracemind/api build
INGEST_RATE_LIMIT_PER_MINUTE=1000000 AUTH_RATE_LIMIT_PER_MINUTE=1000 RETENTION_ENABLED=false \
  NODE_ENV=production DATABASE_URL=… REDIS_URL=… JWT_SECRET=… node apps/api/dist/main.js

# Load (from apps/api)
pnpm load:ingest --url http://localhost:4000 --duration 30 --connections 20 --out load/results/burst.json
pnpm load:ingest --duration 60 --connections 10 --rate 25 --out load/results/sustained.json
```

| Option               | Default                 |                                                   |
| -------------------- | ----------------------- | ------------------------------------------------- |
| `--url`              | `http://localhost:4000` | API base URL                                      |
| `--duration`         | `30`                    | Seconds of load                                   |
| `--connections`      | `20`                    | Concurrent HTTP connections                       |
| `--rate`             | unlimited               | Cap on requests per second across all connections |
| `--traces-per-batch` | `10`                    | Traces per request                                |
| `--spans-per-trace`  | `4`                     | Spans per trace (alternating LLM and tool spans)  |
| `--drain-timeout`    | `600`                   | Seconds to wait for the queue to drain            |
| `--out`              | —                       | Write the full JSON report to this path           |

Each batch holds 50 events: 10 traces, each with 2 LLM spans (with token usage, so cost is
estimated during ingestion) and 2 tool spans. Prompts include an email address, so the redaction
step runs too. The process exits with status 1 if any accepted event is still missing after the
drain timeout.

## Results (2026-11-22)

All components ran on **one 2-vCPU VM** (Intel Xeon @ 2.30 GHz, 8 GB RAM): the API (production
build, one process), PostgreSQL 16, Redis 7 and the load generator itself, competing for the same
two cores. Treat these as a floor, not a capacity plan. The raw reports are in [`results/`](results).

| Scenario                               | HTTP req/s | p50 / p99 latency | Events accepted/s | Events persisted/s | Drain after load | Lost |
| -------------------------------------- | ---------: | ----------------: | ----------------: | -----------------: | ---------------: | ---: |
| Sustained, 25 req/s for 60 s           |         25 |        11 / 46 ms |             1,248 |              1,246 |            0.1 s |    0 |
| Burst, 20 connections for 30 s         |      508 ¹ |        38 / 75 ms |            16,910 |              1,615 |          285 s ² |    0 |
| Burst, `INGESTION_CONCURRENCY=8`, 10 s |        249 |       75 / 167 ms |            12,405 |              1,643 |             66 s |    0 |

¹ Includes 5,070 requests answered `503` with `Retry-After` once the backlog reached
`INGESTION_MAX_QUEUED_BATCHES` (10,000): back-pressure worked as designed, and the SDK retries those
batches. All 508,050 accepted events (101,610 traces, 406,440 spans) were persisted.<br>
² 10,161 batches were queued in 30 s, so the workers needed about 5 minutes to catch up.

### What the numbers say

- **Ingestion stays fast under load.** Validation, redaction and enqueueing take 11 ms at the
  median at a sustainable rate, and stay under 100 ms at p99 with 20 concurrent clients, because
  the request path never touches PostgreSQL.
- **About 1,250 events/s (≈250 traces/s with 4 spans each) are processed with no backlog** on
  this machine, and nothing was lost in any scenario.
- **The workers are the bottleneck, and they are bound by CPU, not by concurrency.** Doubling
  `INGESTION_CONCURRENCY` from 4 to 8 did not raise persistence throughput (1,615 → 1,643
  events/s) and made HTTP latency worse, because the API, workers and PostgreSQL share two cores.
- **To scale:** run dedicated worker processes (`INGESTION_WORKER_ENABLED=false` on the API
  replicas, `true` on the workers) on separate cores or machines. The next optimization in code is
  to write each batch with multi-row upserts instead of one statement per event.
