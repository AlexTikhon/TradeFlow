# ADR 0020: production edge and an isolated AWS mock

Status: Accepted

## Context

The next intended hosted target is AWS. No account/domain is configured; the requested first
deliverable is a local mock. Plain-HTTP development and `pnpm demo` do not exercise production
cookies, real TLS, proxy address handling, container boundaries or durable object storage.

## Decision

Build one pruned Nest API image, one Caddy/static-SPA image and a separate operator-tools target.
Versions of Node and Caddy are pinned by digest. Dependencies install from the frozen lockfile;
the portable runtime tree is additionally checked against that lock's package versions. API
and edge run as uid 1000 with read-only root filesystems in the mock. Database migrations run
as an explicit operation, not on API startup. Seeded public-password users belong to the mock only.

The edge terminates HTTPS, serves the built SPA, and forwards `/api` unchanged. It overwrites
`X-Forwarded-For`, `X-Forwarded-Host` and `X-Forwarded-Proto`, removes `Forwarded`/`X-Real-IP`,
and flushes API responses without buffering. No API/database/object-store port is published.
Hashed static assets are immutable; SPA HTML is revalidated. Session cookies retain the existing
`Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/`, no-Domain and `__Host-` rules.

`TRUSTED_PROXY_CIDRS` defaults to no trust and accepts numeric IPs/CIDRs, not boolean trust,
hop counts, aliases or universal networks. The mock discovers and trusts only its own edge's
actual front-network IPv4 address. Express chooses the nearest untrusted address, never a
client-supplied left-most address. The sign-in guard continues to use `request.ip`.
See [Express proxy behavior](https://expressjs.com/en/guide/behind-proxies/) and
[Caddy streaming/headers](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).

The mock uses real PostgreSQL and an authenticated S3-compatible server as substitutes for RDS
and S3. A private HTTPS listener exposes the object endpoint only on the Docker network. Node
trusts this run's public CA certificate; the API never mounts the CA private key. The browser
test first verifies the leaf certificate against that CA, then pins only its leaf public key
for its isolated Chromium instance. It does not install a system CA or disable TLS validation
globally. The AWS SDK always gets generated mock credentials, not a developer AWS profile.

`GET /api/health` remains database readiness. `GET /api/health/live` is process-only liveness:
a database outage should remove readiness, not trigger a process restart loop.

## Trade-offs and boundaries

- One API process preserves the existing SSE and sign-in admission assumptions. There is no
  broker, outbox or load balancing in this increment.
- The mock persists database, object and certificate data across container restarts within a
  run. Normal shutdown removes this run's volumes; it is not a permanent development database.
- Self-issued certificates and static mock S3 credentials prove protocol behavior, not AWS
  IAM/IMDS, RDS roles/TLS, security groups, public DNS, ACME issuance or provider backups.
- The intended AWS mapping is EC2 + same-origin edge, private RDS PostgreSQL 18, private S3,
  an instance role and SSM administration. Provisioning, cost review and cloud restore remain
  future work; no AWS resources or credentials are created by this mock.
- Recovery of documents and database stays governed by [ADR 0019](0019-s3-document-storage.md).
  There is no new data model or migration and no automatic deletion of complete S3 objects.
