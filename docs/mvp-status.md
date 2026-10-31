# MVP status: acceptance summary

TradeFlow's original MVP is complete: all eight areas below are implemented and covered by
automated tests that passed in Linux CI. Some are complete within deliberate limits, listed
under [Limitations](#limitations). The [demo](demo.md) walks through every area. Its walkthrough
on a seeded voyage has been driven end to end once in a real browser by a script, but not yet by
a person. Its second walkthrough, on a voyage created and set up in the app
([ADR 0016](decisions/0016-initial-voyage-setup.md)), is automated: `pnpm demo:verify` drives it in
Chromium against a fresh one-command demo (`pnpm demo`). It passed locally and in hosted Linux
CI on `d00635f`; no person has run it. What was
verified where, and on which code: [at a glance](#verification-at-a-glance).

## Verification at a glance

**Updated 2026-10-31:** `d00635f6813c4706f3a02e837e2f5cbd47ae457e` is on `origin/main`.
[Hosted run 40710589366](https://github.com/AlexTikhon/TradeFlow/actions/runs/40710589366)
succeeded in all three jobs: `verify`, `e2e`, `demo`. This supersedes the 2026-10-28 statements
below about unpushed commits, sign-in/demo having no hosted evidence and the demo not running on Linux.
Both failure-artifact uploads were skipped, so their behavior remains untested.

The S3 increment, committed locally as `d5cec43`, adds opt-in S3 storage, read-only reconciliation, paired
object export/import and an isolated recovery rehearsal ([runbook](storage-recovery.md),
[ADR 0019](decisions/0019-s3-document-storage.md)). CI's new `storage` job is configured;
hosted evidence for this increment is pending. There is no deployment, scheduled/offsite backup
or cloud-provider restore evidence. The following 2026-10-28 verification records are historical.

The next increment is the requested [local AWS deployment mock](deployment-mock.md): production
containers, HTTPS cookies, explicit proxy trust, SSE and private S3 over TLS. Actual AWS account,
domain, IAM/RDS setup and hosted verification remain deferred. CI has a new `deploy` job;
it has no hosted result yet.

The mock increment passed locally on 2026-10-31: `pnpm check` (1,460 tests and builds),
`pnpm test:e2e` (14), `pnpm demo:verify` (1) and `pnpm deploy:verify` (one production HTTPS
scenario, seven steps). Details and limits: [deployment verification](deployment-mock.md#local-verification-2026-10-31).

### Local S3 increment verification, 2026-10-31

On the uncommitted working tree above `d00635f`, Windows, Node 24.11.1 and pnpm 11.9.0:

| Check              | Result                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `pnpm check`       | Passed: format, lint, typecheck, 193 contracts + 803 API + 460 web tests (1,456), production builds                |
| API `test:storage` | Passed: 14 tests against the real S3 adapter, authenticated SeaweedFS 4.17 and PostgreSQL 18                       |
| `pnpm test:e2e`    | Passed: 14 Chromium tests, no retries                                                                              |
| `pnpm demo:verify` | Passed: 1 fresh-voyage Chromium walkthrough, F1 to F8 and historical file versions                                 |
| Other checks       | Frozen-lockfile install, actionlint 1.7.12, `git diff --check`; 245 local Markdown file links checked, none broken |

The S3 suite exercised multipart completion/abort, chunked uploads past the byte limit, lost
PUT and multipart-completion responses, refused writes/cleanup, competing SQL writes, certain
rollback and both possible outcomes of a lost COMMIT acknowledgement, private access, corruption
and missing bytes. Its recovery rehearsal exported two immutable file versions with a database
dump, restored into an empty database and a new bucket, downloaded both through the real API
with matching SHA-256, and found no discrepancies or unexplained orphans. Overwriting an existing
backup/target and importing a tampered backup were refused.

Regular checks and E2E used explicit URLs on a separate disposable PostgreSQL server; S3 and demo
owned their own servers. Test containers and temporary backup/demo directories were removed.
The existing injected-failure log lines, node-postgres deprecation and Vite chunk-size warnings
did not fail these runs. This is local evidence, not hosted CI or cloud-provider verification.

### Historical snapshot, 2026-10-28

As of 2026-10-28. Local `main` is ahead of `origin/main` by `42ee8f2`, `b91f477` and the commit
that adds the `demo` job with this record; none of them has been pushed.

| Kind                         | Code                                                                                                                               | Evidence                                                                                                                                                                                                                                                |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Latest hosted CI             | `2ad0cd1` (`origin/main`): the Action Center and its fixes                                                                         | [Run 39948306928](https://github.com/AlexTikhon/TradeFlow/actions/runs/39948306928): jobs `verify` and `e2e` succeeded ([details](#latest-hosted-ci-run-2ad0cd1))                                                                                       |
| Newer, local only            | `b91f477` (adds `42ee8f2`, sign-in admission, and `b91f477`, the one-command demo), plus this phase's CI and documentation changes | `pnpm check`, `pnpm test:e2e` and `pnpm demo:verify` passed on Windows 11 against isolated databases ([details](#local-verification-of-b91f477-2026-10-28))                                                                                             |
| Configured, not yet executed | CI's `demo` job: `pnpm demo:verify` on `ubuntu-latest`, the walkthrough's own PostgreSQL container, `demo-diagnostics` on failure  | None. Nothing after `2ad0cd1` has run in hosted CI, so sign-in admission, the demo and the `demo` job have no hosted result                                                                                                                             |
| Not covered                  | —                                                                                                                                  | HTTPS and the production cookie (`Secure`, `__Host-`); any deployment; the demo on Linux (until the `demo` job runs) and on macOS; either failure-artifact upload (`e2e-diagnostics`, `demo-diagnostics`); other browsers; a person, in any walkthrough |

## Latest hosted CI run: `2ad0cd1`

| Item           | Value                                                                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Commit         | `2ad0cd1069702816879c8a4f7b1db9b60e68c087` on `main` (2026-10-23): the Action Center ([ADR 0017](decisions/0017-action-center.md)) and its fixes |
| CI run         | [GitHub Actions run 39948306928](https://github.com/AlexTikhon/TradeFlow/actions/runs/39948306928): success, triggered by the push of that SHA   |
| `verify` job   | Success: format, lint, typecheck, `pnpm test`, build                                                                                             |
| `e2e` job      | Success: `pnpm test:e2e`, 14 of 14 Chromium tests in 8 files, one worker, no retries                                                             |
| `demo` job     | Did not exist yet                                                                                                                                |
| Runners        | `ubuntu-latest`, which resolved to Ubuntu 24.04; Node.js 24.21.0 (`.nvmrc`: 24); PostgreSQL 18 (`postgres:18-alpine`) service                    |
| Upload on fail | **Skipped**, because nothing failed. See [Limitations](#limitations)                                                                             |

Tests that ran, counted from the job logs (inspected read-only on 2026-10-28: Vitest's summary
per package, Playwright's list reporter). Every test passed; none was skipped.

| Layer                   | Where                          | Files | Tests |
| ----------------------- | ------------------------------ | ----- | ----- |
| Schemas                 | `packages/contracts`           | 10    | 193   |
| API unit and PostgreSQL | `apps/api` (both projects)     | 34    | 765   |
| Web on MSW, jsdom       | `apps/web/src/**/*.test.ts(x)` | 19    | 459   |
| Chromium end to end     | `e2e/tests/*.spec.ts`          | 8     | 14    |
| **Total**               |                                | 71    | 1,431 |

These are the files and counts of the [local run of 2026-10-23](#local-verification-2026-10-23),
now also passed in CI; the Action Center's four Chromium tests are among the fourteen. The three
earlier Action Center commits (`cd2f7bd`, `7ec5d47`, `0c9fb64`) also passed CI. Documentation
committed later does not change this evidence; `42ee8f2` and `b91f477` change code and tests and
have not been pushed, so they need a run of their own.

## Local verification of `b91f477`, 2026-10-28

**Not CI evidence.** One run of each command on commit
`b91f477dec768ed63ec1af5518b5217c6181d593`, the head of local `main`. The working tree differed
only by this phase's workflow and documentation changes, with no application or test code. The
machine ran Windows 11 Home, Node.js 24.11.1, pnpm 11.9.0 and Docker 29.7.2. `pnpm check` and
`pnpm test:e2e` ran against a disposable PostgreSQL 18.6 container created for the run (data on
tmpfs, a loopback port Docker chose), with explicit `TEST_DATABASE_URL` (`…/tradeflow_test`) and
`E2E_DATABASE_URL` (`…/tradeflow_e2e`) pointing at it. Port 5433 belonged to another project's
PostgreSQL on this machine and was not used. `pnpm demo:verify` started its own container, as it
always does.

| Command            | Result                                                                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm demo:verify` | Passed: 1 of 1 Chromium test, every step (sign-in, F1 to F8, earlier versions), voyage TF-2026-0008; 34 s from codegen to cleanup; container and directory removed |
| `pnpm test:e2e`    | Passed: 14 of 14 Chromium tests in 8 files, one worker, no retries                                                                                                 |
| `pnpm check`       | Passed: format, lint, typecheck, every Vitest suite, build                                                                                                         |
| `git diff --check` | No whitespace errors                                                                                                                                               |

| Layer                   | Where                          | Files | Tests |
| ----------------------- | ------------------------------ | ----- | ----- |
| Schemas                 | `packages/contracts`           | 10    | 193   |
| API unit and PostgreSQL | `apps/api` (both projects)     | 37    | 794   |
| Web on MSW, jsdom       | `apps/web/src/**/*.test.ts(x)` | 19    | 460   |
| Chromium end to end     | `e2e/tests/*.spec.ts`          | 8     | 14    |
| Demo walkthrough        | `e2e/demo/walkthrough.spec.ts` | 1     | 1     |
| **Total**               |                                | 75    | 1,462 |

Against the CI run at `2ad0cd1`, the API gained three files (`sign-in-admission.spec.ts`,
`auth.service.spec.ts`, `sign-in-admission.int-spec.ts`) and tests in `app-config.spec.ts` and
`openapi.int-spec.ts`; the web gained one test in `auth-flow.test.tsx`; the demo walkthrough is
new. None of these has run in hosted CI. The API's log has the expected
`ERROR [VoyageEventBus]` line (see the [historical CI record](#hosted-ci-run-at-5baf039-2026-10-18))
and four `POST /api/auth/sign-in failed` errors with "commit outcome unknown". Those four are
injected on purpose by "gives the slots back when the held sign-ins fail" in
`sign-in-admission.int-spec.ts`, which passed. The disposable container, and everything the
three commands created, was removed afterwards.

## Historical records

Kept as written at the time. Later evidence is above; where a record's claim has since been
overtaken, a note says so.

### Local verification, 2026-10-28

**Historical: the run before `b91f477` was committed.** It ran on the uncommitted working tree;
the commit itself was verified again [above](#local-verification-of-b91f477-2026-10-28).

**Not CI evidence.** The one-command demo (`pnpm demo`) and its automated fresh-voyage
walkthrough (`pnpm demo:verify`) were added on top of `42ee8f2` (which includes ADR 0018), and
verified on the uncommitted working tree with this phase's changes, on Windows 11 Home with
Node.js 24.11.1, pnpm 11.9.0 and Docker 29.7.2. `pnpm check` and `pnpm test:e2e` ran against a
disposable PostgreSQL 18.6 container of their own, published on a loopback port, with explicit
`TEST_DATABASE_URL` (`…/tradeflow_test`) and `E2E_DATABASE_URL` (`…/tradeflow_e2e`) pointing
at it: the default port 5433 on this machine belonged to another project's PostgreSQL, which was
not used.

| Command            | Result                                                                                                    |
| ------------------ | --------------------------------------------------------------------------------------------------------- |
| `pnpm demo:verify` | Passed twice, each from its own fresh demo: 1 of 1 Chromium test, F1 to F8, voyage TF-2026-0008 each time |
| `pnpm check`       | Passed: format, lint, typecheck, every Vitest suite, build                                                |
| `pnpm test:e2e`    | Passed: 14 of 14 Chromium tests in 8 files, one worker, no retries                                        |

| Layer                   | Where                          | Files | Tests |
| ----------------------- | ------------------------------ | ----- | ----- |
| Schemas                 | `packages/contracts`           | 10    | 193   |
| API unit and PostgreSQL | `apps/api` (both projects)     | 37    | 794   |
| Web on MSW, jsdom       | `apps/web/src/**/*.test.ts(x)` | 19    | 460   |
| Chromium end to end     | `e2e/tests/*.spec.ts`          | 8     | 14    |
| Demo walkthrough        | `e2e/demo/walkthrough.spec.ts` | 1     | 1     |

The API's two Vitest projects report one combined count here. The demo walkthrough is separate
from `pnpm test:e2e` and from CI: it uses the real seed and the production sign-in budget, where
the suite uses generated organizations and a raised budget. What it drove and observed, how its
queue polling moves the page clock, the interactive start and stop (Ctrl+C, `q`), a server
killed mid-run, interrupted and failing startups, and a cleanup failure reported with its
recovery: [automated runs of walkthrough 2](demo.md#automated-runs-of-walkthrough-2). Every
container, directory and process the checks created was removed; the containers, volumes and
listening servers present before were unchanged afterwards. Linux, macOS and a person were not
covered.

Changes to application code in this phase: one. The API accepts an optional `HOST` to listen
on (unset: every interface, as before), so the demo binds it to 127.0.0.1; one unit test.

### Local verification, 2026-10-23

**Historical; since overtaken by CI.** Its statement that no CI run had verified the Action
Center was true when written. CI later passed with the same files and counts:
[run 39948306928 at `2ad0cd1`](#latest-hosted-ci-run-2ad0cd1).

**Not CI evidence.** The Action Center ([ADR 0017](decisions/0017-action-center.md)) was added
after the CI run above, and no CI run has verified it yet. These are the results of one local run,
on the uncommitted working tree on top of `0c9fb64` (the Action Center, its initial-load
invalidation fix, its Chromium tests and the seed's reference-counter fix), run in sequence on
Windows 11 with Node.js 24.11.1, against a disposable PostgreSQL 18.6 container with explicit
`TEST_DATABASE_URL` (`…/tradeflow_test`) and `E2E_DATABASE_URL` (`…/tradeflow_e2e`).

| Command            | Result                                                             |
| ------------------ | ------------------------------------------------------------------ |
| `pnpm check`       | Passed: format, lint, typecheck, every Vitest suite, build         |
| `pnpm test:e2e`    | Passed: 14 of 14 Chromium tests in 8 files, one worker, no retries |
| `git diff --check` | No whitespace errors                                               |

| Layer                   | Where                          | Files | Tests |
| ----------------------- | ------------------------------ | ----- | ----- |
| Schemas                 | `packages/contracts`           | 10    | 193   |
| API unit                | `apps/api/src/**/*.spec.ts`    | 19    | 234   |
| API on PostgreSQL, HTTP | `apps/api/test/*.int-spec.ts`  | 15    | 531   |
| Web on MSW, jsdom       | `apps/web/src/**/*.test.ts(x)` | 19    | 459   |
| Chromium end to end     | `e2e/tests/*.spec.ts`          | 8     | 14    |
| **Total**               |                                | 71    | 1,431 |

The ten earlier Chromium tests all still pass; the four new ones are in `action-center.spec.ts`
([ADR 0017, browser coverage](decisions/0017-action-center.md#browser-coverage)). The Action
Center was also inspected in Chromium screenshots at 1280 × 800, 390 × 844 and 360 × 740 (queue
with a long rejection reason, a historical deep link, loading, load failure and refresh failure):
no horizontal scrolling at any width, the linked record focused below the sticky header. At 360 px
the header's **Sign out** label wraps onto two lines inside its button; nothing overflows or is
hidden. Its [three-minute walkthrough](demo.md#walkthrough-3-the-action-center-in-three-minutes)
was driven once by a script, not by a person ([record](demo.md#record-of-walkthrough-3)).

### Hosted CI run at `5baf039`, 2026-10-18

**Historical.** The verified build of the original MVP and ADR 0016, before the Action Center.

| Item           | Value                                                                                                                                          |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Commit         | `5baf03935d08291cdc032f71fa1146614d2d626f` on `main` (2026-10-18), which includes ADR 0016                                                     |
| CI run         | [GitHub Actions run 39139518806](https://github.com/AlexTikhon/TradeFlow/actions/runs/39139518806): success, triggered by the push of that SHA |
| `verify` job   | Success: format, lint, typecheck, `pnpm test`, build                                                                                           |
| `e2e` job      | Success: `pnpm test:e2e`, 10 of 10 Chromium tests, one worker, no retries                                                                      |
| Runners        | `ubuntu-latest`, which resolved to Ubuntu 24.04; Node.js 24.21.0 (`.nvmrc`: 24); PostgreSQL 18 (`postgres:18-alpine`) service                  |
| Upload on fail | **Skipped** in this run, because nothing failed. See [Limitations](#limitations)                                                               |

Tests that ran in that run, counted from its job logs (Vitest's per-file lines and summaries,
Playwright's list reporter). Every test passed; none was skipped.

| Layer                   | Where                          | Files | Tests |
| ----------------------- | ------------------------------ | ----- | ----- |
| Schemas                 | `packages/contracts`           | 9     | 160   |
| API unit                | `apps/api/src/**/*.spec.ts`    | 16    | 176   |
| API on PostgreSQL, HTTP | `apps/api/test/*.int-spec.ts`  | 14    | 488   |
| Web on MSW, jsdom       | `apps/web/src/**/*.test.ts(x)` | 15    | 311   |
| Chromium end to end     | `e2e/tests/*.spec.ts`          | 7     | 10    |
| **Total**               |                                | 61    | 1,145 |

Against the previous verified run ([39116071881](https://github.com/AlexTikhon/TradeFlow/actions/runs/39116071881),
commit `e0f698d`, 55 files and 989 tests), the new files are `organizations.spec.ts`,
`trade-string-setup.spec.ts`, `organizations.int-spec.ts`, `trade-string-setup.int-spec.ts`,
`VoyageTradeStringSetup.test.tsx` and the Chromium `trade-string-setup.spec.ts`; existing files
gained tests too (for example `preconditions.spec.ts`, now 42).

The API's test log contains one `ERROR [VoyageEventBus] A listener failed on NOTICE_ISSUED`
line. It is expected: the unit test "keeps a failing listener from reaching the publisher or the
other listeners" in `voyage-event-bus.spec.ts` makes a listener throw on purpose, and it passed.

## What each kind of verification proves

- **PostgreSQL over HTTP** (API integration). The real Nest application, booted against a real
  PostgreSQL 18 database (`tradeflow_test`), is driven through HTTP. Every response is checked
  against the shared Zod contract. This is where authorization, transactions, audit rollback,
  database constraints (hit with plain SQL), real races on held row locks, multipart uploads to a
  real storage directory, and event streams over real HTTP connections are proven. It never runs
  a browser.
- **MSW on jsdom** (web). The real route tree, providers and query cache run in jsdom. Only the
  network is faked, by MSW, and an unhandled request fails the test. `EventSource` is a fake
  driven by hand. This layer proves UI behaviour: what each role is offered, what each request
  sends (`If-Match`, `If-None-Match`), conflicts, draft and file preservation, and identity
  changes mid-request. jsdom has no layout, no real cookies and no real `EventSource`.
- **Real Chromium, automated suite** (end to end, CI's `e2e` job). A production web build and the
  built API run against a fresh PostgreSQL database through the same-origin proxy, with real
  sign-in, cookies and the browser's own `EventSource`. The live-update tests prove from the
  browser's network log that a stream message, not polling, refreshed the other party's page;
  the Action Center tests, that each queue learned of a change by its own polling. The suite is a
  smoke layer: 14 tests in 8 files (10 at `5baf039`), Chromium only, plain HTTP, each with
  generated organizations. All but `trade-string-setup.spec.ts` write their voyage and contract
  straight into the database; that one creates its voyage and sets up its trade string through
  the UI. Faults come only from a labelled transport proxy (a 503, a held or dropped stream).
- **Real Chromium, scripted demo walkthrough** (once, locally, on 2026-10-18;
  [record](demo.md#walkthrough-record)). A Playwright script drove all six demo steps through
  the UI of the development servers (Vite dev server, API in watch mode). It used two isolated
  browser contexts, on a throwaway database with all migrations and the real seed. This covers
  what the suite does not: the seeded multi-contract voyage, the stale draft caused by a pushed
  acknowledgement, the server's PDF signature refusal, and the outsider and viewer checks in a
  browser. It is not a test in the repository, did not run in CI, and is not a human run of the
  demo. It predates ADR 0016, so it did not create a voyage or set up a trade string.
- **Real Chromium, automated demo walkthrough** (`pnpm demo:verify`, locally on 2026-10-28:
  twice before `b91f477` was committed, [record](demo.md#automated-runs-of-walkthrough-2), and
  once on the commit, [above](#local-verification-of-b91f477-2026-10-28)). A Playwright test in the
  repository drives the fresh-voyage walkthrough (steps F1 to F8) through the UI of a demo
  started exactly as `pnpm demo` starts one: built apps, a fresh PostgreSQL 18 container, every
  migration and the real seed, production sign-in admission. It creates and sets up a voyage on
  seeded organizations, then instructions, a rejected, replaced and approved bill of lading
  (download compared by SHA-256), both Action Center queues (reached by their own 30-second
  polling on a moved page clock), earlier versions, the timeline, the final buyer's view and an
  outsider. The `demo` job passed in hosted Linux CI on `d00635f`. It is not a human run.
- **Fresh-voyage walkthrough, by a person** ([demo, steps F1 to F8](demo.md#walkthrough-2-a-fresh-voyage)):
  **not yet performed.** The automated test proves the flow and the wording, not the pacing, real
  window focus, the native file and download dialogs, or how it reads to an audience. Its
  [human record](demo.md#record-of-walkthrough-2) is empty.

## The eight MVP areas

The "Walkthrough" column names the [demo](demo.md) steps in which a browser run by a script or
test exercised each area: steps 1 to 6 by the scripted run of 2026-10-18, steps F1 to F8 by
`pnpm demo:verify` (2026-10-28). No person has run either.

| #   | Area                           | Status                            | Implementation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | PostgreSQL / HTTP                                                                                                                                                                                                                                           | MSW / jsdom                                                                                                    | Chromium suite                                                                                                                     | Walkthrough                                       |
| --- | ------------------------------ | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| 1   | Organizations, users and RBAC  | Done; seeded accounts             | Organizations are the tenancy boundary, and each user belongs to one. Email and password (argon2id), server-side sessions in an `HttpOnly`, `SameSite=Strict` cookie. Voyage access follows participation. `VIEWER` reads; `OPERATOR` reads and acts, read on every request and checked in the service performing each command ([ADR 0006](decisions/0006-participation-based-access.md), [0007](decisions/0007-cookie-sessions.md), [0008](decisions/0008-user-roles.md))                                                                                                                                                                                                   | `auth.int-spec.ts` (17); an outsider-404 test in every feature's file; viewers refused with 403 in voyage creation, notices, instructions, documents and reviews; unit: password, session cookie                                                            | `auth-flow.test.tsx` (19), `session.test.ts` (32); a viewer test in each panel and in `NewVoyagePage.test.tsx` | `authentication.spec.ts` (sign-in, reload, cookie flags), `session-tabs.spec.ts` (two tabs, two users)                             | Setup, 1, 6 (outsider, viewer); F1, F8 (outsider) |
| 2   | Voyages                        | Done                              | List with status filter, details, creation by operators (`PLANNED`, server-assigned `TF-<year>-<n>`, creator's organization as exporter); `voyages` module, Zod contract ([ADR 0005](decisions/0005-shared-zod-api-contract.md))                                                                                                                                                                                                                                                                                                                                                                                                                                             | `voyages.int-spec.ts` (18), `voyage-creation.int-spec.ts` (31, incl. concurrent references, audit rollback), `openapi.int-spec.ts` (10)                                                                                                                     | `VoyageListPage.test.tsx` (6), `VoyageDetailsPage.test.tsx` (12), `NewVoyagePage.test.tsx` (19)                | `trade-string-setup.spec.ts`: creation through the form, then the voyage in the buyer's list; every journey opens the details page | 1, 6 (lists); F1 (creation)                       |
| 3   | Trade-string visualization     | Done; set up once, then read-only | Sale contracts stored as edges, with row rules in the database and chain rules in the domain. Every participant sees the topology, never terms ([ADR 0010](decisions/0010-trade-string-visibility.md)). The voyage page draws the parties in contract order, marks the viewer's own organization, and keeps service providers out of the string. Beyond the MVP: the one-time setup of a new voyage's chain by its exporter's operators, and an operator-only organization search ([ADR 0016](decisions/0016-initial-voyage-setup.md)), from the voyage page                                                                                                                 | `trade-string.int-spec.ts` (23), `trade-string-setup.int-spec.ts` (60, incl. two races, revalidation after the lock, audit rollback), `organizations.int-spec.ts` (12); unit `trade-string.spec.ts` (24), `trade-string-setup.spec.ts` (11)                 | Trade-string tests in `VoyageDetailsPage.test.tsx`; `VoyageTradeStringSetup.test.tsx` (26)                     | `trade-string-setup.spec.ts`: create, set up, buyer gives instructions                                                             | 1; F2, F3 (setup, the buyer gains access)         |
| 4   | Notices                        | Done; ETA notices only            | ETA notices from the seller to the buyer under one contract, counterparty-only; immutable once issued; acknowledged once by conditional update; overdue derived ([ADR 0011](decisions/0011-counterparty-notices.md))                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `notices.int-spec.ts` (57, incl. a race on a held lock); unit `notice-rules.spec.ts` (11)                                                                                                                                                                   | `VoyageNotices.test.tsx` (32), `local-date-time.test.ts` (39, DST)                                             | `live-notices.spec.ts`: issue and acknowledge across two contexts, live                                                            | 2                                                 |
| 5   | Documentary instructions       | Done                              | Buyer to seller under one contract; immutable revisions; acknowledgement of an exact revision; one conditional statement per write with `ETag`/`If-Match` (412, 428); a draft kept until the user re-bases it ([ADR 0012](decisions/0012-documentary-instructions.md))                                                                                                                                                                                                                                                                                                                                                                                                       | `documentary-instructions.int-spec.ts` (81, incl. four real races); unit `instruction-rules`, `preconditions`                                                                                                                                               | `VoyageDocumentaryInstructions.test.tsx` (22: 412 and refresh conflicts, drafts kept)                          | `live-instructions.spec.ts` (2): give, acknowledge, revise live; a pushed revision leaves a draft alone                            | 3, 4; F4                                          |
| 6   | Documents: upload and approval | Done; local storage               | Per document an exact revision requires: PDF upload, accepted when declared `application/pdf`, non-empty, at most 10 MiB (enforced while streaming) and starting with `%PDF-` (a signature check, not a structural one). Immutable versions with SHA-256. Bytes staged outside the transaction, removed after a certain rollback, kept and logged when the commit outcome is unknown. Counterparty-only attachment downloads. The buyer approves, or rejects with a reason, the latest version: one final decision per file version, and one document version for uploads and decisions ([ADR 0013](decisions/0013-documents.md), [0014](decisions/0014-document-review.md)) | `documents.int-spec.ts` (71, files on disk checked after every failure), `document-reviews.int-spec.ts` (48, incl. review against replacement in both orders), `document-review-migration.int-spec.ts` (2); unit `document-rules`, `local-document-storage` | `VoyageDocuments.test.tsx` (36), `VoyageDocumentReviews.test.tsx` (20)                                         | `live-documents.spec.ts`: upload through the form, download compared by SHA-256, approval, replacement, rejection, history         | 5 (incl. a refused fake PDF); F5 to F7            |
| 7   | Audit timeline                 | Done; read-only                   | Append-only `audit_events` written in the command's transaction; a cursor-paginated timeline, newest first, scoped per contract, identifiers only ([ADR 0009](decisions/0009-transactional-audit-events.md))                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `voyage-timeline.int-spec.ts` (29); a forced audit failure rolls back each command, in each feature's file                                                                                                                                                  | `VoyageTimeline.test.tsx` (8)                                                                                  | Timeline entries asserted in the three `live-*` tests                                                                              | 2 to 6; F1 to F8                                  |
| 8   | Real-time updates              | Done; best effort                 | One SSE stream per voyage; type-only signals after commit, to current counterparties, re-checked before delivery and every 30 s; the page re-reads what a signal concerns over REST, everything on (re)connection, and polls while disconnected ([ADR 0015](decisions/0015-voyage-event-streams.md))                                                                                                                                                                                                                                                                                                                                                                         | `voyage-events.int-spec.ts` (29, real HTTP streams); unit `voyage-event-streams`, `voyage-event-bus`                                                                                                                                                        | `VoyageLiveUpdates.test.tsx` (30, fake `EventSource`)                                                          | The three `live-*` tests; `stream-recovery.spec.ts` (3: drop, 503, catch-up); `session-tabs.spec.ts`                               | 2 to 5 (no reconnection tested); F4               |

Numbers in brackets are per-file test counts from the historical
[CI run at `5baf039`](#hosted-ci-run-at-5baf039-2026-10-18), ADR 0016's files included; later runs
are counted per layer only, above, and several of these files have gained tests since. Not in the
MVP, and not started: editing a
recorded chain or adding participants any other way, further notice types,
notifications, deadlines and tasks, amending decisions, object storage and AI-assisted
extraction ([README](../README.md#roadmap)).

## Limitations

- **Organizations and users come from the seed.** No API or screen creates an organization or
  a user or invites an organization. A voyage created in the app has only its creator's
  organization, as exporter, until an operator of it sets up its chain once on the voyage page
  (ADR 0016), which adds the named organizations as participants; a recorded chain cannot be
  changed, and nobody else can be added. Most Chromium tests still write their voyage and
  contract directly into the database; `trade-string-setup.spec.ts` creates and sets up its
  own through the UI.
- **One API instance.** The event bus is in process. A second API instance would not receive the
  other's signals, and nothing coordinates several.
- **Best-effort live updates.** Signals are not stored, carry no ids and cannot be replayed. A
  signal lost while a stream is down is made up for by the refetch on every (re)connection and by
  30-second polling while disconnected. REST stays the source of truth.
- **Document storage.** The default is a private local directory (`DOCUMENT_STORAGE_DIR`);
  opt-in S3-compatible storage and an offline paired backup/restore are now available
  ([runbook](storage-recovery.md)). No scheduled/offsite backup or cloud-provider restore has
  been verified. There is no virus scanning. The PDF check is a signature
  check: a file that starts with `%PDF-` but is otherwise broken is accepted. Orphaned bytes (a
  crash between keeping a file and committing it, a failed removal, an unknown commit outcome)
  are logged and removed by a manual procedure
  ([architecture](architecture.md#operational-concerns-current-state)).
- **Chromium over plain HTTP.** The end-to-end suite and the scripted walkthrough ran Chromium
  only, over HTTP. The production cookie's `Secure` attribute and `__Host-` name, other browsers'
  cookie and `EventSource` behaviour, and the native date-time, file and download dialogs are not
  covered. The walkthrough looked at the full page, but no test checks layout.
- **The failure-artifact uploads have not been exercised.** CI is configured to upload
  `e2e/.output/` as `e2e-diagnostics` when the e2e suite fails, and `e2e/.output/demo/` as
  `demo-diagnostics` when the demo walkthrough fails (hidden files included, cookie- and
  trace-bearing paths excluded, a missing upload failing the step). Every hosted run so far
  passed, so both uploads were skipped. A green run says
  nothing about whether either upload works; only a failing run will.
- **The demo has not been run by a person.** The [walkthrough record](demo.md#walkthrough-record)
  is of a scripted Chromium session on the seeded voyage. It found one cosmetic defect: after an
  upload, the emptied upload form's disabled button shows a stale version number. A bounded fix
  is proposed there. The [fresh-voyage walkthrough](demo.md#walkthrough-2-a-fresh-voyage) is
  automated (`pnpm demo:verify`, passed locally on 2026-10-28) but has not been run by a person.
  The hosted `demo` job passed on `d00635f`.
- **The one-command demo is local only.** `pnpm demo` needs a running Docker daemon and was
  checked on Windows 11 and subsequently by CI on Linux (`d00635f`); macOS remains unchecked. It runs `NODE_ENV=development`
  over plain HTTP, so it says nothing about a deployment. Its state is discarded on every stop; a
  demo killed before it can clean up leaves its container, directory and two processes running,
  to be removed by hand as [described](demo.md#starting-the-demo-pnpm-demo).
- **Other known gaps:** sign-in is limited only in process, per client address (no lockout, no
  limit shared between instances, [ADR 0018](decisions/0018-sign-in-admission.md)), no SSO, no password reset
  ([ADR 0007](decisions/0007-cookie-sessions.md)). Seeded notice times are relative to when the
  seed ran, so their awaiting, overdue and acknowledged states drift until the next seed.
