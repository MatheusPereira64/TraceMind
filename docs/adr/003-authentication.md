# ADR-003: Session cookies for people, hashed API keys for machines

- Status: accepted
- Date: 2026-11-05

## Context

Two very different clients call the API: people using the dashboard and applications sending
telemetry. They need different credentials, lifetimes and failure modes.

## Decision

**Dashboard sessions**

- Stateless HS256 JWT (`sub`, `iss`, `exp`) in an `httpOnly`, `SameSite=Lax` cookie, `Secure` in production.
  The token is also returned in the body so scripts can use `Authorization: Bearer`.
- The global `SessionGuard` re-reads the user on every request; deleting a user revokes access at once.
- CSRF: the dashboard calls the API through a same-origin proxy (ADR-004); `SameSite=Lax` blocks
  cross-site POSTs and CORS only allows the configured dashboard origin.

**Passwords**

- Node's built-in `scrypt` (memory-hard) instead of argon2 to avoid a native addon in the image.
  Parameters N=2¹⁵, r=8, p=3 follow one of OWASP's equivalent scrypt configurations at ~32 MiB per hash.
  Parameters are stored in each hash and upgraded on the next successful login.

**API keys**

- Format `tm_<dev|stg|prod>_<32 base64url chars>` (192 bits of randomness). The environment tag makes
  leaked keys easy to identify in secret scanners and logs.
- Only `sha256(key)` is stored. A slow KDF is unnecessary for uniformly random 192-bit secrets, and a
  fast hash allows an indexed equality lookup on every ingestion request.
- Keys belong to a project and carry a default environment; they can expire and be revoked.
  `last_used_at` is updated at most once a minute, off the request path.

## Consequences

- Stateless sessions cannot be revoked individually before expiry (12 h default). If needed, add a
  `sessions` table or a Redis deny-list keyed by `jti` — the guard is the only place to change.
- Credentials are not interchangeable: API keys are rejected on dashboard routes and vice versa.
