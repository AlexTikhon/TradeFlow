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
pnpm hosted:rehearse-mock   # the hosted runbook end to end against a mock (see below)
```

`pnpm hosted:rehearse-mock` starts a mock **without** the demo seed and prepares the hosted
verification accounts through the controlled fixture tool. It runs the
[hosted verification suite](hosted-verification.md) with an API restart done outside the
browser test, then the paired backup and an identity-guarded restore into a new empty database
and bucket. The one API is recreated against the restored stores and the suite runs again in
restored mode. Only that rehearsal sets `MOCK_DATABASE_NAME`/`MOCK_S3_BUCKET` in
`deploy/mock/compose.yml`; their defaults are the run's own `tradeflow_mock`/`tradeflow-mock`.
The suite's local trust (this run's CA and CA-verified leaf key) is a separate input, accepted
only for `https://localhost`. Hosted targets always use public trust.

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
  private S3 endpoint, which refuses it anonymously (403);
- a request through the edge with a spoofed `X-Request-ID`, a bearer token and a secret in its
  path and query gets a fresh server-generated `X-Request-ID`; the API container's own log has
  exactly that id on an `unmatched` 404 lifecycle record, and neither the spoofed id nor the
  secret appears in its log.

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
- `upload-response.json`: status, media type, `requestId` (the response's `X-Request-ID`), size
  and Problem Details fields of an unexpected upload response.

The API writes one JSON lifecycle record per request on standard output, best effort
([HTTP diagnostics](architecture.md#http-diagnostics)), so `api.log` holds them unless the log
pipe fell behind and records were dropped. To find the
server's side of the failed upload, search `api.log` for the `requestId` from
`upload-response.json`: its record has the route template, status, duration, outcome and, for a
5xx, the error's class, code and a few stack frames. For the 2026-11-25 CA failure below that
would have read `"error":{"source":"exception","name":"Error","code":"UNABLE_TO_GET_ISSUER_CERT_LOCALLY",…}`
(the TLS error's code; not re-run). Records contain no URL, header, body or message, so the
sanitizer below has nothing extra to redact in them; it re-serializes them unchanged.

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

### HTTP diagnostics, local verification, 2026-11-26

Server-generated request ids and one JSON lifecycle record per request
([HTTP diagnostics](architecture.md#http-diagnostics)) were verified on Windows (Node 24.11.1,
pnpm 11.9.0, Docker 29.9.3 with the WSL2 backend), on the working tree committed after
`bd9c233`:

| Check                            | Result                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm check`                     | Passed against a disposable PostgreSQL 18.6 container on 127.0.0.1:5544, checked over TCP first (server address = the container's, database `tradeflow_test`, role `tradeflow`, postmaster started with the container): contracts 193, API 857 (42 files), web 520 (22 files), build                                                    |
| New API tests                    | 17 unit (lifecycle races, listener release, failing sink, spoofed id, route/method allowlist, failure classification) and 17 integration through the real pipeline (success, guard and validation rejections, 5xx, 40 concurrent requests, unmatched routes, aborts, downloads, SSE, failing sink, disabled)                            |
| `pnpm demo:verify`               | Passed (1 test) with `HTTP_REQUEST_LOG=bogus` in the caller's shell: the API would refuse that value, so it was not inherited                                                                                                                                                                                                           |
| `pnpm demo:portfolio:verify`     | Passed (3 tests), with the same caller value                                                                                                                                                                                                                                                                                            |
| `pnpm deploy:verify`             | Passed: 1 test, 8 steps, no retries. Through the HTTPS edge, a spoofed `X-Request-ID` was replaced by a fresh id, the API container's log had exactly one `unmatched` 404 record with it, and neither the spoofed id nor the request's secret appeared in that log                                                                      |
| `pnpm check`, first two attempts | Failed only in `document-review-migration`'s cleanup hook (all 857 tests passed): its `DROP DATABASE` checkpoint synced 37,876 files in 10.8 s against a 10 s hook limit, after every suite's `TRUNCATE`. The unchanged `bd9c233` integration project took 8.0 s (28,958 files) on the same server and passed. The hook now allows 60 s |

The two first attempts are recorded because the margin was real: CI on Linux syncs faster, but
the hook's cost grows with the number of tests before it. Hosted CI has not run this change.

### HTTP diagnostics writer, local verification, 2026-11-26

At `3e47280` the records were written with a bare `process.stdout.write()`. Two defects were
reported from probes: a closed stdout pipe ended the process with an unhandled asynchronous
EPIPE, and a stdout pipe that was not read let Node's buffer grow without bound. The bounded
writer ([HTTP diagnostics, Writer](architecture.md#http-diagnostics)) was verified on Windows
(Node 24.11.1, pnpm 11.9.0, Docker 29.9.3) and on Linux in a container
(`mcr.microsoft.com/playwright:v1.63.0-noble`, Ubuntu 24.04, Node 24.20.0, kernel
6.18.33.2-microsoft-standard-WSL2), with a fresh `pnpm install` on a disposable volume. The
"old writer" rows were run in that container's throwaway copy, with the module's factory
pointed back at the bare write.

| Check                                         | Result                                                                                                                                                                                                                                                               |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reader closes the pipe, old writer            | Child crashed: the next request failed with `ECONNRESET` (Windows and Linux)                                                                                                                                                                                         |
| Reader closes the pipe, `StreamSink`          | Child alive, sink `failed`, 20 more requests and a final one answered 200 with fresh ids; clean shutdown, exit 0, no sink listeners left (Windows and Linux)                                                                                                         |
| Paused reader, 3 × 3,000 requests, old writer | All answered; `process.stdout.writableLength` 556,167 → 1,203,116 → 1,849,943 bytes                                                                                                                                                                                  |
| Paused reader, 3 × 3,000 requests, writer     | All answered; held bytes 65,385 after every burst (bound 65,536), 8,291 records dropped. The sink stayed `open`: the bound tripped before the pipe's 64 KiB high-water mark. Resumed: held bytes fell to 0 and records flowed again (Linux)                          |
| Process spec, paused reader (Linux only)      | Passed: 6,000 requests answered, held bytes within the bound, then records received + records dropped = requests made, all whole JSON records                                                                                                                        |
| Windows pipe, paused reader                   | Not run as a test: a 100 KB burst of stdout writes blocked the event loop for 2,952 ms until the reader resumed (Node writes Windows pipes synchronously)                                                                                                            |
| Mutations                                     | Without the sink's `error` listener, 6 of 11 writer unit tests fail with unhandled errors; without the pending-error check, the listener-release test fails with an unhandled error                                                                                  |
| `pnpm check`                                  | Passed against a disposable PostgreSQL 18.6 container on 127.0.0.1:5544, checked over TCP first (server address 172.17.0.2 = the container's, database `tradeflow_test`, role `tradeflow`): contracts 193, API 870 + 1 skipped (the Linux-only spec), web 520, build |
| `pnpm demo:verify`                            | Passed (1 test)                                                                                                                                                                                                                                                      |
| `pnpm demo:portfolio:verify`                  | Passed (3 tests)                                                                                                                                                                                                                                                     |
| `pnpm deploy:verify`                          | Passed: 1 test, no retries, including the request-id/record correlation through the HTTPS edge, with the production writer in the API container                                                                                                                      |

Not shown: hosted CI (not run), stdout redirected to a file or a terminal (synchronous in Node,
so a stalled destination there still stalls the API), and Docker's log driver itself falling
behind. That last case is a pipe on Linux and should behave like the paused reader above, but it
was not produced.

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

The production Docker targets and public-domain Caddyfile are reused unchanged by the
[AWS infrastructure foundation](aws-infrastructure.md): Terraform for the EC2 instance, private
RDS and S3, ECR, the scoped instance role and SSM access, with offline tests, the deployment
contract and a [cost worksheet](aws-cost-worksheet.md). It has not been applied. Before
provisioning, select the account/role, region, domain, resource sizes and cost ceiling (the
exact list is in that document), then rehearse the paired recovery procedure in that account
before keeping non-disposable data. The operator sequence, the hosted suite and the evidence
template are in [hosted verification](hosted-verification.md).
