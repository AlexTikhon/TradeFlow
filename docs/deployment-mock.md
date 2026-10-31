# AWS deployment mock

This is the local precursor to the first AWS environment, requested before account/domain
setup. It uses production builds, real TLS and real PostgreSQL/S3-compatible services. It
neither contacts AWS APIs nor provisions cloud resources. [ADR 0020](decisions/0020-production-edge-and-aws-mock.md)
records the boundaries and [storage recovery](storage-recovery.md) covers paired backups.

## Run

Requires Node >=24.11, pnpm 11.9.0, Docker with Compose, and Playwright Chromium:

```powershell
pnpm install --frozen-lockfile
pnpm --filter @tradeflow/e2e exec playwright install chromium
pnpm deploy:verify   # builds, starts, exercises and removes an isolated mock
pnpm deploy:mock     # interactive; Ctrl+C or q + Enter removes this run
```

The first build downloads pinned images/dependencies. Subsequent builds reuse BuildKit layers
and the pnpm store cache. The banner prints random loopback HTTP/HTTPS ports and the owned
Compose project. Fictional users/passwords are the [demo accounts](demo.md); credentials and
data are generated anew each run. This command ignores development database/object-store
configuration. It does not use the development Compose project or port 5433.

For manual browsing, the certificate is signed by a temporary mock CA; a regular browser will
report it as untrusted. Its public certificate lives in the printed temporary directory. The
automated run uses a scoped certificate pin after real CA/hostname verification; it does not
alter your machine's trust store. No real domain is needed for the local mock.

## Topology

| Intended AWS component            | Local substitute                                                                       | Exposure                                   |
| --------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------ |
| EC2 API process                   | Pruned Node image, production mode, uid 1000                                           | Docker front + DB networks only            |
| Same-origin HTTPS edge/static SPA | Caddy image, uid 1000                                                                  | Random ports on 127.0.0.1 only             |
| Private RDS PostgreSQL 18         | PostgreSQL 18 + named volume                                                           | DB network only                            |
| Private S3 bucket                 | Authenticated SeaweedFS, named volume, HTTPS through a separate internal edge listener | Object network / private TLS listener only |
| Deployment operator               | Separate tools image for migration and fictional seed                                  | Mock networks; exits after each operation  |

There is one API instance. The API and proxy have read-only root filesystems and temporary
`/tmp`; their persistent evidence is in the database and object service. Only the proxy's
public CA certificate is mounted into the API. All ports except the loopback edge are private.

Proxy trust defaults to off in development/tests. The runner discovers the edge's exact address
and configures that `/32` for the production API. The edge overwrites forwarded headers from
clients. Do not set blanket proxy trust, trust a hop count, expose port 3000, or reuse this
topology behind another ingress without reviewing how that ingress supplies addresses.

## Verification scope

`pnpm deploy:verify` checks the built containers through the real edge:

- HTTP redirects to HTTPS; deep-link fallback, API routing and immutable asset caching;
- verified CA/hostname TLS, production `__Host-` cookie flags, no Domain, HttpOnly browser behavior;
- a real browser EventSource receiving committed changes through the proxy;
- a PDF larger than the multipart threshold saved via the private HTTPS S3 endpoint, with a
  counterparty API download matching its SHA-256;
- session, database and document survival after an API restart;
- DB readiness becoming 503 while process liveness remains 200, then recovery without an API restart;
- changing spoofed forwarding headers cannot move sign-in attempts to a fresh budget;
- sign-out revokes the prior session; no API/DB/S3 ports are published and API/edge are non-root.

Separate API integration tests check trusted versus untrusted peers and the nearest-untrusted
address rule. The existing E2E suite remains the business-flow regression coverage. The mock's
own production sign-in budget is unchanged. Browser traces, videos and storage-state exports
are disabled; failure screenshots/results remain ignored under `e2e/.output/deploy/`.

### Local verification, 2026-10-31

On the uncommitted increment above `d5cec43`, Windows host Node 24.11.1/pnpm 11.9.0, Linux
containers Node 24.22.1/Caddy 2.11.7:

| Check                | Result                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm deploy:verify` | Passed: 1 Chromium scenario, all seven steps, no retries; containers, volumes, generated image tags and temporary files removed |
| `pnpm check`         | Passed: format/lint/typecheck, 193 contract + 807 API + 460 web tests (1,460) and both builds                                   |
| `pnpm test:e2e`      | Passed: 14 Chromium tests                                                                                                       |
| `pnpm demo:verify`   | Passed: 1 fresh-voyage walkthrough                                                                                              |
| Deployment config    | Public Caddyfile adapted successfully; actionlint 1.7.12 and diff checks passed                                                 |

The seven-step mock included a second genuine TCP client receiving a fresh budget after the
first was limited, and replay of the prior session returning 401 **after** sign-out answered 204.
The public-key pin was generated only after real CA/hostname validation of the leaf certificate.
Earlier failed attempts exposed Caddy's upstream file capability and pnpm's runtime auto-install;
the delivered images remove that unused capability and invoke installed operator CLIs directly.
These local results are not hosted CI or AWS-provider evidence.

This does not prove AWS IAM/instance roles, EC2 metadata access, RDS permissions or server
certificates, VPC/firewall behavior, public DNS/ACME, managed backups or hosted availability.
The mock DB user and S3 identity have broader fixture privileges than the future hosted roles.

## Stop and recover

Normal teardown removes only this random Compose project, its volumes, its generated image tags
and its temporary directory. BuildKit caches and shared base images remain. API/container
restart preserves data; stopping the entire mock discards it. Startup cancellation is observed
between Docker operations, so the current build/operation can finish before cleanup begins.

If the process was killed before cleanup, use the **project name and recovery environment file
printed by that run**, from this repository:

```powershell
docker compose --project-name <that-project> --env-file <that-temp-directory>/compose.env --file deploy/mock/compose.yml down --volumes --remove-orphans
```

Inspect the Compose labels before acting: `com.docker.compose.project` must equal that exact
project. Its generated credentials/certificates are disposable and must never be committed.
Remove its temporary directory and its three printed image tags only after the project is down.
Never use `docker system prune`, a global container stop, or a process-name kill to recover it.

## Move to AWS later

The production Docker targets and public-domain Caddyfile are reusable, but there is no AWS
deployment in this increment. Before provisioning, select the account/role, region, domain,
resource sizes and cost ceiling; produce a concrete infrastructure plan. Then configure a
private RDS instance with an appropriate application role/TLS, a private S3 bucket and scoped
instance role, SSM access, retained certificate/config storage, DNS, and the paired recovery
procedure. Rehearse in that actual account before keeping non-disposable data.
