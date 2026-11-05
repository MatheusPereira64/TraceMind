# ADR-004: Same-origin API proxy in the dashboard

- Status: accepted
- Date: 2026-11-05

## Context

The dashboard (Next.js, port 3000) and API (port 4000) are separate services. Calling the API
directly from the browser requires cross-origin cookies, CORS with credentials, and baking the API URL
into the client bundle at build time.

## Decision

The dashboard exposes `src/app/api/[...path]/route.ts`, a thin route handler that forwards `/api/v1/*`
and `/api/health*` to `API_INTERNAL_URL` (read at runtime). It forwards an allow-list of headers in
both directions, including `Set-Cookie`, applies a 30 s timeout and returns `502` when the API is down.

## Consequences

- The session cookie is first-party to the dashboard origin; no third-party-cookie issues.
- One dashboard image can point at any API (staging/production) via an environment variable.
- One extra network hop for dashboard traffic. Telemetry ingestion does **not** go through the proxy:
  SDKs and collectors call the API directly.
- The API sees the dashboard server as the client IP. When the API is only reachable through trusted
  proxies, set `TRUST_PROXY=true` so rate limits use `X-Forwarded-For`.
