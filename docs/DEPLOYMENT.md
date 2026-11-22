# Deploying TraceMind

This guide puts TraceMind on a single Linux server with Docker Compose, behind
[Caddy](https://caddyserver.com) with automatic HTTPS. Everything runs from
[`docker-compose.prod.yml`](../docker-compose.prod.yml):

```
                Internet ── 80/443 ──▶ Caddy (TLS, HTTP/2 + HTTP/3)
                                          │
                     /v1/*, /docs, /health │  everything else
                              ┌────────────┴────────────┐
                              ▼                         ▼
                         API :4000  ◀── /api proxy ── Dashboard :3000
                       (NestJS + workers)             (Next.js)
                          │        │
                   PostgreSQL 17  Redis 7 (queue, AOF)
```

Only Caddy publishes ports. PostgreSQL, Redis, the API and the dashboard are reachable only on the
Compose network, which is what makes `TRUST_PROXY=true` safe: every request reaches the API through
Caddy, which overwrites `X-Forwarded-For` with the real client address.

## 1. Requirements

| Item   | Minimum                                                       | Notes                                                                                                        |
| ------ | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Server | 2 vCPU, 4 GB RAM, 40 GB SSD, Ubuntu 24.04 or any Docker host  | Measured: about 1,250 events/s ingested with no backlog on 2 vCPU ([load test](../apps/api/load/README.md)). |
| Docker | Docker Engine 24+ with the Compose plugin                     | `curl -fsSL https://get.docker.com \| sh`                                                                    |
| Domain | An A (and optionally AAAA) record pointing at the server's IP | Needed before the first start so Let's Encrypt can issue the certificate.                                    |
| Ports  | 22 (SSH), 80 and 443 (TCP), 443 (UDP, for HTTP/3) open        | Port 80 is used for the certificate challenge and redirects to HTTPS.                                        |

Building the dashboard image needs about 2 GB of free memory. On a 2 GB server, add swap or build the
images elsewhere and push them to a registry.

## 2. First deployment

```bash
# On the server
git clone https://github.com/MatheusPereira64/TraceMind.git tracemind && cd tracemind

cp .env.production.example .env.production
chmod 600 .env.production
# Fill in TRACEMIND_DOMAIN, ACME_EMAIL, POSTGRES_PASSWORD and JWT_SECRET:
#   openssl rand -base64 32 | tr -d '/+='   → POSTGRES_PASSWORD
#   openssl rand -base64 48                 → JWT_SECRET
nano .env.production

docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
docker compose -f docker-compose.prod.yml --env-file .env.production ps
```

On start, the one-shot `migrate` service applies database migrations and loads the model price
registry; the API starts only if it succeeds. Caddy obtains the certificate on the first request
(watch it with `docker compose … logs -f caddy`).

To avoid repeating the flags, an alias helps:

```bash
alias tm='docker compose -f docker-compose.prod.yml --env-file .env.production'
tm ps && tm logs -f api
```

### Check it

```bash
curl https://tracemind.example.com/health/ready     # {"status":"ok","checks":{"database":"up","redis":"up"}}
```

Then open `https://tracemind.example.com`, create your account, a project and an API key.

### Close registration

Anyone who can reach the server can sign up while `REGISTRATION_ENABLED=true`. Once your account
exists:

```bash
sed -i 's/^REGISTRATION_ENABLED=.*/REGISTRATION_ENABLED=false/' .env.production
tm up -d api
```

Existing accounts keep signing in; `POST /v1/auth/register` answers `403`.

## 3. Sending telemetry

Applications send telemetry straight to the public domain over HTTPS:

```ts
const tracemind = new TraceMind({
  apiKey: process.env.TRACEMIND_API_KEY, // tm_prod_…
  baseUrl: 'https://tracemind.example.com',
});
```

- **OpenTelemetry (OTLP/HTTP JSON):** export to
  `https://tracemind.example.com/v1/ingest/otlp/v1/traces` with `Authorization: Bearer <key>` and
  JSON encoding.
- **OTLP gRPC:** start the optional collector with `tm --profile otel up -d` after setting
  `TRACEMIND_COLLECTOR_API_KEY`. It listens on `127.0.0.1:4317/4318` only; reach it through a
  private network, VPN or SSH tunnel, never by publishing it.
- **API reference:** `https://tracemind.example.com/docs` (OpenAPI document at `/v1/openapi.json`).

## 4. Operations

### Updates

```bash
git pull
tm up -d --build
```

`migrate` runs again before the new API starts. Migrations only move forward, so take a backup
first (below). To make rollbacks quick, build each release with its own tag
(`TRACEMIND_VERSION=v1.2.0` in `.env.production`) and keep the previous tag around. Rolling back
to an image older than the database schema requires restoring the backup taken before the update.

### Backups

PostgreSQL holds everything that matters. Redis holds only batches waiting in the ingestion queue
(persisted with AOF, so a restart does not lose them).

```bash
# mkdir -p backups, then a nightly compressed dump kept for 14 days (crontab -e)
0 2 * * * cd /home/deploy/tracemind && docker compose -f docker-compose.prod.yml --env-file .env.production exec -T postgres pg_dump -U tracemind -Fc tracemind > backups/tracemind-$(date +\%F).dump && find backups -name '*.dump' -mtime +14 -delete
```

Copy `backups/` off the server (object storage, another host). A backup that has never been
restored is a hope, so test the restore once:

```bash
tm stop api web
tm exec -T postgres pg_restore -U tracemind -d tracemind --clean --if-exists < backups/tracemind-2026-11-22.dump
tm start api web
```

### Data retention

A daily job (03:17 UTC by default, `RETENTION_CRON`) deletes traces older than each project's
retention (30 days by default, editable per project), together with their spans, token usage,
errors and evaluations. Run it on demand after lowering a project's retention:

```bash
tm exec api node dist/retention/run.js                       # all projects
tm exec api node dist/retention/run.js --project <projectId> # one project
```

Disk usage grows with traffic times retention. PostgreSQL does not return space to the OS after
deletes by itself; autovacuum makes it reusable, which is usually enough.

### Monitoring

| Signal                                  | Where                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------- |
| Liveness / readiness                    | `GET /health`, `GET /health/ready` (503 when PostgreSQL or Redis is down) |
| Container health                        | `tm ps` (the API and dashboard images have health checks)                 |
| Structured logs (JSON, with request ID) | `tm logs -f api`; every error response carries the same `requestId`       |
| Ingestion failures                      | Project page in the dashboard, or `GET /v1/projects/{id}/ingestion`       |
| Back-pressure                           | `503` + `Retry-After` from `/v1/ingest/*` when the queue is full          |

Point an external uptime check (UptimeRobot, Better Stack, …) at `/health/ready`. Logs rotate at
20 MB × 5 files per container.

### Scaling

The API process also runs the ingestion workers. The [load test](../apps/api/load/README.md) shows
that the workers are CPU-bound, so throughput grows with cores rather than with
`INGESTION_CONCURRENCY`. When the queue keeps growing:

1. Give the server more vCPUs (the simplest step).
2. Run dedicated workers: add a service using the API image with `INGESTION_WORKER_ENABLED=true`
   and no published port, set `INGESTION_WORKER_ENABLED=false` on `api`, and scale workers with
   `tm up -d --scale worker=2`.
3. Move PostgreSQL to a managed service or its own machine and point `DATABASE_URL` at it.

## 5. Security checklist

- [ ] `.env.production` is `chmod 600` and not in git (it is ignored by `.gitignore`).
- [ ] `POSTGRES_PASSWORD` and `JWT_SECRET` are random and unique to this deployment. Changing
      `JWT_SECRET` signs everyone out.
- [ ] `REGISTRATION_ENABLED=false` once your account exists.
- [ ] Only ports 22, 80 and 443 are reachable (`ufw allow OpenSSH && ufw allow 80,443/tcp && ufw allow 443/udp && ufw enable`).
      Docker bypasses ufw for published ports, which is why only Caddy publishes any.
- [ ] SSH with keys only (`PasswordAuthentication no`).
- [ ] Backups run and have been restored at least once.
- [ ] Project redaction settings cover your data (secrets and e-mails are masked by default; add
      internal hostnames or customer names under _Custom terms_).

## 6. Troubleshooting

| Symptom                                    | Cause and fix                                                                                                                                |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser shows a certificate error          | DNS does not point at the server yet, or port 80 is blocked. Check `tm logs caddy`, fix, then `tm restart caddy`.                            |
| `api` never becomes healthy                | `tm logs migrate` and `tm logs api`. An `Invalid environment configuration` message lists the variable to fix.                               |
| Sign-in works but you are logged out again | The site is served over plain HTTP: `COOKIE_SECURE=true` requires HTTPS. Use the domain, not the server IP.                                  |
| SDK gets `401`                             | Wrong key, a revoked key, or the project was archived. `curl -H "Authorization: Bearer $KEY" https://…/v1/ingest/whoami`.                    |
| SDK gets `429`                             | Per-key limit (`INGEST_RATE_LIMIT_PER_MINUTE`, default 600 requests/min). Raise it or send larger batches (up to 1000 events).               |
| SDK gets `503`                             | The ingestion queue is full: the workers are behind. The SDK retries; see Scaling.                                                           |
| Costs show "no price"                      | The model is not in `apps/api/pricing/models.json`. Add it with its source and run `tm up -d --build`: the price sync recomputes past costs. |
