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

`pnpm deploy:verify` first builds `@tradeflow/contracts` on the host, because the Playwright
scenario imports its response schemas from `packages/contracts/dist`, which a fresh checkout
lacks. The images build their own copy inside Docker (`.dockerignore` excludes host `dist`).
`pnpm deploy:mock` imports nothing from contracts on the host and needs no such step.

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
- sign-out revokes the prior session; no API/DB/S3 ports are published and API/edge are non-root;
- the API, as uid 1000 with only its mounted mock CA, completes a verified HTTPS request to the
  private S3 endpoint, which refuses it anonymously (403).

Separate API integration tests check trusted versus untrusted peers and the nearest-untrusted
address rule. The existing E2E suite remains the business-flow regression coverage. The mock's
own production sign-in budget is unchanged. Browser traces, videos and storage-state exports
are disabled; failure screenshots/results remain ignored under `e2e/.output/deploy/`.

### Failure diagnostics

When startup, the post-startup setup or the scenario fails (a timeout or a crashed worker
included), `e2e/deploy/diagnostics.ts` writes evidence to `e2e/.output/deploy/diagnostics/`
**before** the owned containers are removed, and prints the API log tail:

- `summary.txt`: the reason, the Compose project and each service's state;
- `api.log`, `edge.log`, `s3.log`: the last 300 lines per service, at most 64 KiB each;
- `upload-response.json`: status, media type, size and Problem Details fields of an
  unexpected upload response.

Before writing, the run's generated database password and S3 keys are replaced, and so are
cookies, `Authorization`/signature/credential values, database URL passwords, private keys,
header maps in structured log lines, and terminal colors. Nothing is read from the mock's temporary
directory (recovery environment, S3 identity, certificates), and no PDF bodies, dumps, browser
state, HARs or traces are written. A collection problem is logged in one line and never
blocks cleanup or replaces the original error. Each run clears the directory first. The CI
`deploy` job uploads `e2e/.output/deploy/` as `deploy-diagnostics` (7 days) when the step fails.

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

### Hosted CI and cold-start fix, 2026-11-25

[Hosted run 41198286937](https://github.com/AlexTikhon/TradeFlow/actions/runs/41198286937) at
`baf9a67`: `verify`, `e2e`, `demo` and `storage` passed; `deploy` failed before any HTTPS step
with `Cannot find module …/@tradeflow/contracts/dist/index.js` imported from
`e2e/deploy/https.spec.ts`. The earlier local pass most likely ran with a `contracts/dist` left by a prior build.

`pnpm deploy:verify` now builds contracts first. Locally, Windows host Node 24.11.1/pnpm 11.9.0,
Docker 29.9.3, in a fresh worktree after `pnpm install --frozen-lockfile` with
`packages/contracts/dist` confirmed absent and no other build step: the original import error
reproduced before the fix; with it, the scenario passed (one Chromium test, seven steps, no
retries), and containers, volumes, networks, image tags and temporary directories matched their
pre-run state. Hosted `deploy` success is still unverified until CI runs on the fix.

### Hosted upload 500: unreadable mock CA on Linux hosts, 2026-11-25

[Hosted run 45627100683](https://github.com/AlexTikhon/TradeFlow/actions/runs/45627100683) at
`fc62608` (ubuntu-latest): `verify`, `e2e`, `demo` and `storage` passed. `deploy` built
contracts, started the mock and passed the first three steps. The multipart-sized upload then
answered 500 instead of 201 (`https.spec.ts:244`) after 83 ms. The job log held no server-side
cause, because the API log was removed with its container.

**Reproduction.** The Playwright host side ran on Linux: a container from
`mcr.microsoft.com/playwright:v1.63.0-noble` (Node 24.20.0, Chromium 1243, Docker CLI 29) ran as
uid 1001 with umask 0022, like the hosted runner. It used a Linux `git clone` of `84239e0`
on an ext4 Docker volume mounted at its own daemon path, so Compose bind mounts resolve with
Linux ownership and modes, plus the Docker socket and host networking. With the new
diagnostics, the 500 reproduced, and the API log showed where it failed:

```text
Warning: Ignoring extra certs from `/etc/tradeflow/mock-ca.crt`, load failed: error:8000000D:system library::Permission denied
…
ERROR [ProblemDetailsFilter] POST …/documents/BILL_OF_LADING/versions failed
Error: unable to get local issuer certificate
    at TLSSocket.onConnectSecure (node:internal/tls/wrap:1788:34)
```

The failure is in **S3 transport (TLS trust)**. The request was received, authorized and its
write precondition checked. The first S3 call made while staging the streamed bytes then failed
its handshake, before the PDF checks completed and before any SQL write. The
upload's compensation also failed for the same reason ("Could not remove failed upload…").
Credentials, readiness, certificate hostnames and the SDK were not involved.

**Cause.** A standalone probe isolated the mechanism. Caddy writes its local root
`root.crt` as `0600`, owned by uid 1000. `mock-run.ts` copies it out with `docker cp`, which keeps
the mode and, on a Linux host, makes the copy owned by the invoking user (uid 1001 on the
runner). Bind-mounted read-only into the API, uid 1000 then gets `Permission denied`. Node
skips `NODE_EXTRA_CA_CERTS` with only a warning, so the API starts and stays healthy. The
first request to use the private HTTPS endpoint fails, and that is the upload. Docker
Desktop on Windows presents the same bind-mounted file as `0777 root`, which is why every
Windows run passed.

**Fix.** `mock-run.ts` makes the copied file `0644`. It is the public CA certificate; the key
never leaves the edge's volume. Certificate and hostname verification, private S3
authentication, the uid 1000 API, container isolation, upload limits and the PDF size are
unchanged. **Regression:** the first scenario step now runs a verified HTTPS request from
inside the API, as uid 1000 and with no explicit `ca`, to `https://objects:9443/tradeflow-mock`,
and expects S3's anonymous 403.

| Run (2026-11-25)                                                  | Result                                                                                                    |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Linux host, `84239e0` + diagnostics                               | Failed as hosted: upload 500; diagnostics captured the API log above                                      |
| Linux host, + regression, before fix                              | Failed in step 1: `Expected "403"`, received `unable to get local issuer certificate`                     |
| Linux host, + fix                                                 | Passed: 1 test, 7 steps, no retries                                                                       |
| Linux host, final tree, no `contracts/dist`                       | Passed: 1 test, 7 steps, no retries; no owned resources or temporary directories left                     |
| Windows host, final tree, no `contracts/dist` or `.output/deploy` | Passed: 1 test, 7 steps, no retries; Docker resources and temporary directories matched the pre-run state |
| Linux host, injected API startup failure                          | Diagnostics kept (API config error, service states); none of the 3 generated credentials in any output    |
| Linux host, injected startup failure + failing diagnostics        | One-line collection error; original startup error reported; all owned resources removed                   |

Host: Windows Node 24.11.1, pnpm 11.9.0, Docker 29.9.3 (WSL2 backend), Compose 5.7.1. Static
checks: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, actionlint 1.7.12 and
`git diff --check` passed. No application, storage or database code changed, so `pnpm check`
and `pnpm test:storage` were not rerun. The Linux runs approximate the hosted runner but are
not hosted evidence: hosted `deploy` success is unverified until CI runs on this change.

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
