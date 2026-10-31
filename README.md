# TradeFlow

TradeFlow is a B2B platform for the **post-trade execution of bulk commodity shipments**: the
operational work that happens after a cargo of soybeans, corn or wheat has been sold, often
several times over, between the exporter and the final buyer.

```
Exporter ──sells to──▶ Trader A ──sells to──▶ Trader B ──sells to──▶ Final buyer
                    one physical cargo, one vessel, many commercial relationships
```

Every party in that chain works on the same physical shipment, but each has separate contracts,
documents and obligations. TradeFlow models that shared workspace. Today that means voyages, the
organizations taking part in them, the trade string, ETA notices from sellers to buyers,
documentary instructions from buyers to sellers, the documents sellers present against them, and
the buyers' decisions on those documents, with a timeline of who did what; notices, documentary instructions, documents and the timeline update live as they change.
Next come further notices, deadlines and workflow.

> This is an engineering portfolio project. It is inspired by real commodity-shipping workflow
> problems, but it is not a clone of any commercial product, and all organizations and people in the
> demo data are fictional.

## Status: original MVP complete

The eight original MVP areas are implemented. The latest hosted run on `d00635f` passed
`verify`, `e2e` and `demo` ([run 40710589366](https://github.com/AlexTikhon/TradeFlow/actions/runs/40710589366)),
including sign-in admission and the fresh-voyage walkthrough on Linux. `pnpm demo` starts a
fresh, isolated demo; `pnpm demo:verify` drives it in Chromium. No person has run a walkthrough.

The next increment adds opt-in private S3-compatible document storage and a paired database/object
[recovery procedure](docs/storage-recovery.md), including `pnpm test:storage` against isolated
PostgreSQL and an authenticated S3 server. Local storage remains the default. Hosted CI for
this increment and an actual cloud-provider recovery rehearsal are pending.

For the next AWS phase, an isolated [deployment mock](docs/deployment-mock.md) is available:
`pnpm deploy:verify` exercises production containers, HTTPS cookies, proxy trust, SSE and private
S3 over TLS. `pnpm deploy:mock` keeps that local stack running until stopped. No AWS account or
domain is needed; no AWS resources are created. Actual AWS deployment remains deferred.
[Acceptance summary](docs/mvp-status.md) (what was verified where and on which commit, coverage
by test layer, limitations) · [ten-minute demo](docs/demo.md) (with the walkthrough records) ·
[handoff](docs/handoff.md) (restarting work: commands, data, recovery, next directions).

| Area         | Delivered                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth         | Email + password sign-in (argon2id), server-side sessions in an HttpOnly cookie, `GET /api/auth/me`, sign-out that revokes the session; sign-in admission in process: 20 attempts per client address a minute and 4 sign-ins at once, refused with 429 and `Retry-After` ([ADR 0018](docs/decisions/0018-sign-in-admission.md))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Access       | Every voyage query scoped to the voyages the user's organization participates in; non-participants get the same 404 as for a missing voyage                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Roles        | `VIEWER` (read) and `OPERATOR` (read and act) per user, read on every request and checked in the service that performs each command ([ADR 0008](docs/decisions/0008-user-roles.md))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Writes       | `POST /api/voyages`: starts `PLANNED`, creator's organization becomes `EXPORTER`, server-assigned `TF-<year>-<number>`; issuing and acknowledging notices; giving, revising and acknowledging documentary instructions with `If-Match`/`ETag` (412 when stale, 428 without a precondition); uploading document versions and approving or rejecting them, both conditional on the document's version. Each command and its audit event commit in one transaction                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Trade        | Sale contracts stored as edges (`trade_contracts`), row rules in the database, chain rules (linear, exporter → traders → final buyer) in the domain; every participant sees the topology, never contract ids or terms ([ADR 0010](docs/decisions/0010-trade-string-visibility.md))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Notices      | ETA notices from the seller to the buyer under one contract, readable only by those two organizations; an operator of the seller issues, an operator of the buyer acknowledges receipt (not acceptance) once, by conditional update; overdue derived from the deadline, late acknowledgement allowed ([ADR 0011](docs/decisions/0011-counterparty-notices.md))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Instructions | Documentary instructions from the buyer to the seller under one contract (consignee, notify party, up to eight required documents), counterparty-only; immutable revisions, the seller acknowledges an exact revision, a new revision starts unacknowledged; every write is one conditional SQL statement, so races end in one success and one 412 ([ADR 0012](docs/decisions/0012-documentary-instructions.md))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Documents    | PDFs the seller presents for each document the current instruction revision requires: multipart upload (PDF by content, at most 10 MiB, enforced while streaming), immutable versions with size, SHA-256, uploader and time, `If-Match` for replacements, attachment downloads for both counterparties; bytes staged outside the transaction in private storage under server-generated keys, compensated on every failure ([ADR 0013](docs/decisions/0013-documents.md)). The buyer's operators approve or reject the latest version, a rejection with its reason; one final decision per file version, kept with that file when it is replaced; the document's version counts uploads and decisions, so a replacement never passes over a decision unseen ([ADR 0014](docs/decisions/0014-document-review.md))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Timeline     | `GET .../timeline`: the audit trail as a read-only timeline, newest first, cursor-paginated; the voyage's creation for every participant, notice, instruction and document events only for that contract's two counterparties; who, for which organization, when and identifiers, never the recorded contents ([ADR 0009](docs/decisions/0009-transactional-audit-events.md))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Live updates | `GET .../events`: a server-sent-event stream per voyage that signals issued and acknowledged notices, revised and acknowledged documentary instructions, and uploaded and reviewed document versions after commit, carrying only the type of change, only to the contract's current counterparties, with the session and participation re-checked before every delivery and every 30 s; in-process and best effort (no replay, one API instance); the page refetches what each signal concerns (notices, instructions or documents) and its timeline, all four on every (re)connection, and polls them while disconnected ([ADR 0015](docs/decisions/0015-voyage-event-streams.md))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| API          | `GET`/`POST /api/voyages`, `GET /api/voyages/:voyageId`, `GET .../trade-string`, `POST .../trade-string` (one-time setup of a new voyage, [ADR 0016](docs/decisions/0016-initial-voyage-setup.md), proposed), `GET /api/organizations?search=` (operators), `.../my-contracts`, `.../timeline`, `.../events` (SSE), `GET`/`POST .../notices`, `GET .../notices/:noticeId`, `POST .../notices/:noticeId/acknowledgement`, `GET .../documentary-instructions`, `GET`/`PUT .../contracts/:contractId/documentary-instructions`, `POST .../revisions/:n/acknowledgement`, `GET .../documents`, `POST .../revisions/:n/documents/:type/versions`, `GET .../versions/:v/content`, `POST .../versions/:v/review`, `GET /api/action-items` (the organization's open actions across voyages, [ADR 0017](docs/decisions/0017-action-center.md), proposed), `GET /api/vessels`, `/commodities`, `/ports`, `/api/auth/*`, `GET /api/health`, OpenAPI at `/api/docs`                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Web          | Sign-in, protected routes, user menu; voyage list (status filter in the URL), details with the trade string drawn in contract order (and, for operators of the exporter of a new voyage, a form to set it up once: search, order, review), an ETA notice panel (list, issue, acknowledge), a documentary-instruction panel (revisions, form, acknowledgement; a draft survives a conflict and is re-sent only after the user reviews the newer version), documents under each revision (upload, version history with every decision, authenticated download, approve or reject; a chosen file or a decision being made survives every failure, and a conflict says whether a new file or a decision caused it), a timeline of who did what (older pages on request), notices, instructions, documents and timeline kept current from the voyage's event stream (polling while it is down; a chosen file or a decision being made is never re-based, re-sent or re-targeted by a push), an Action Center (`/actions`: the organization's open actions across voyages, filters in the URL, a page at a time, refreshed on its own) whose items open the exact notice, revision or file version on its voyage's page (history when superseded or replaced, never a command), and a creation form for operators; cache partitioned by identity and purged on every change; writes never retried and dropped if the identity changed |
| Data         | PostgreSQL 18 schema with DB-enforced invariants (immutable issued notices, instruction revisions, document versions and decisions, versioned instructions and documents, append-only audit events), and an idempotent demo seed (7 voyages, 6 of them with a trade string, 4 ETA notices, 12 organizations, 14 users)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Quality      | Strict TypeScript, type-aware ESLint, Prettier, 1,447 Vitest tests (authorization, transactions, races and constraints tested against real PostgreSQL), 14 Chromium end-to-end tests run separately (`pnpm test:e2e`) and the one-test demo walkthrough (`pnpm demo:verify`), as counted locally on `b91f477` on 2026-10-28 ([MVP status](docs/mvp-status.md#local-verification-of-b91f477-2026-10-28)); GitHub Actions CI runs the checks, the smoke suite and the demo walkthrough as three jobs, all passed on `d00635f`; the new `storage` job covers the S3 increment                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

Voyage creation, the one-time setup of a new voyage's trade string, ETA notices, documentary instructions,
documents and their review write data. Seeded trade strings are read-only; an exporter's operator sets up a
new voyage's chain once, on its page, which adds the named organizations as participants.
Editing or correcting a trade string, editing voyages, adding participants any other way or inviting
organizations, other notice types, editing notices, amending or reopening document decisions,
notifications, live updates of the voyage itself and its trade string, delivery across several API instances and AI features are
**intentionally not built yet**. See
[Roadmap](#roadmap) and the [domain model](docs/domain-model.md#eta-notices).

## Architecture at a glance

```
apps/web  (React 19 · Vite · MUI · TanStack Query · React Router)
   │  HTTP/JSON, same origin (/api proxied in dev)
   ▼
apps/api  (NestJS 12 modular monolith · Prisma 7)
   │
   ▼
PostgreSQL 18

packages/contracts  (Zod schemas, the API contract, imported by both apps)
```

- **Modular monolith.** One deployable with explicit domain modules, not microservices
  ([ADR 0001](docs/decisions/0001-modular-monolith.md)).
- **One API contract.** Zod schemas in `packages/contracts` validate requests in the API, type and
  validate responses in the web app, and generate the OpenAPI document
  ([ADR 0005](docs/decisions/0005-shared-zod-api-contract.md)).
- **Server state in TanStack Query, UI state in the URL.** There is no global client store yet,
  because nothing needs one ([ADR 0003](docs/decisions/0003-frontend-server-state.md)).
- **Errors are RFC 9457 Problem Details** (`application/problem+json`) everywhere.
- **Sessions, not JWTs.** An opaque token in an HttpOnly, SameSite=Strict cookie; only its hash is
  stored, so sign-out and revocation take effect immediately
  ([ADR 0007](docs/decisions/0007-cookie-sessions.md)).
- **Access follows participation.** One predicate, applied inside every voyage query, decides
  what an organization can see ([ADR 0006](docs/decisions/0006-participation-based-access.md)).

Details: [docs/architecture.md](docs/architecture.md) · Domain:
[docs/domain-model.md](docs/domain-model.md) · Decisions: [docs/decisions/](docs/decisions/)

## Repository layout

```
apps/
  api/                 NestJS API
    prisma/            schema, migrations, demo seed
    src/
      modules/         auth (sessions, guards) and domain modules (voyages, ...)
      common/http/     problem details, validation pipe, OpenAPI wiring
      infrastructure/  Prisma client
      config/          validated environment config
    test/              integration tests (real PostgreSQL)
  web/                 React SPA
    src/
      app/             shell: providers, routes, layout, theme
      features/        one folder per feature: auth, voyages/{api,domain,components,pages}
      shared/          cross-feature api client, identity scope, ui, formatting
      test/            MSW server, fixtures, render helpers
packages/
  contracts/           Zod schemas + inferred types shared by api and web
e2e/                   Playwright smoke tests in Chromium (support/: run setup, fixtures, proxy)
  demo/                `pnpm demo` and `pnpm demo:verify`: one-command demo, automated walkthrough
docs/                  architecture, domain model, ADRs, demo, MVP status, handoff
docker/                Postgres init scripts
```

## Getting started

**Prerequisites:** Node.js ≥ 24.11, pnpm 11 (`corepack enable` picks up the pinned version),
Docker.

### Quick demo: one command

With a running Docker daemon, after `pnpm install`, in PowerShell or a Linux shell:

```bash
pnpm demo
```

It starts a PostgreSQL 18 container of its own, applies the migrations, runs the demo seed,
builds and starts the API and the web app on 127.0.0.1, then prints the address to open, the
accounts (password `tradeflow-demo`) and the walkthrough to follow. **Every run starts fresh and
nothing is kept:** press Ctrl+C (or type `q` and Enter) and it removes its container, data,
uploaded files and builds. It never uses `DATABASE_URL`, `.env` files or your development
database, and leaves other containers and servers alone. Details, and recovery if it is killed
before it can clean up: [docs/demo.md](docs/demo.md#starting-the-demo-pnpm-demo).

`pnpm demo:verify` starts a demo the same way, drives the fresh-voyage walkthrough through it in
headless Chromium (two browser contexts, seller and buyer), and removes everything afterwards.
It needs Playwright's Chromium once: `pnpm --filter @tradeflow/e2e exec playwright install chromium`.
CI runs the same command as its `demo` job.

### Development setup

```bash
pnpm install
cp apps/api/.env.example apps/api/.env

pnpm db:up          # PostgreSQL 18 on localhost:5433 (creates tradeflow and tradeflow_test)
pnpm db:migrate     # apply migrations
pnpm db:seed        # load demo data (safe to re-run)

pnpm dev            # API on :3000, web on :5173
```

For a guided walkthrough with a seller and a buyer side by side, see [docs/demo.md](docs/demo.md).

Open <http://localhost:5173> and sign in. Every seeded user's password is `tradeflow-demo`; these
accounts show how visibility follows participation, and what each user role may do:

| Email                                   | Organization (role on voyages)    | User role | Sees voyages                   |
| --------------------------------------- | --------------------------------- | --------- | ------------------------------ |
| `ana.souza@cerrado-graos.example`       | Cerrado Grãos (exporter)          | Operator  | TF-2026-0001, 0002, 0007       |
| `rafael.lima@cerrado-graos.example`     | Cerrado Grãos (exporter)          | Viewer    | TF-2026-0001, 0002, 0007       |
| `claire.morel@lacustra.example`         | Lacustra Commodities (trader)     | Operator  | TF-2026-0001, 0003, 0005       |
| `sanne.devries@nordlys.example`         | Nordlys Trading (trader)          | Operator  | TF-2026-0001, 0004, 0006       |
| `katrin.vogel@rhinevalley.example`      | Rhine Valley Crushers (buyer)     | Operator  | TF-2026-0001, 0004             |
| `jonas.weber@lacustra.example`          | Lacustra Commodities (trader)     | Viewer    | TF-2026-0001, 0003, 0005       |
| `lucia.ferreyra@pampalitoral.example`   | Pampa Litoral (exporter)          | Operator  | TF-2026-0003, 0004             |
| `pieter.bakker@atlasinspection.example` | Atlas Cargo Inspection (surveyor) | Operator  | TF-2026-0001, 0002, 0003, 0005 |

Operators see **New voyage** on the voyage list. A voyage they create gets the next reference
(the seed's last is TF-2026-0007) and is visible to their organization only, as its exporter.

Each voyage's details page draws its **trade string**. Worth a look as Claire Morel (Lacustra):
TF-2026-0001 runs through two traders; on TF-2026-0005 Meridian sells to Lacustra, the reverse of
the alphabetical order the participant list uses; TF-2026-0003 has no contracts yet and shows
"Trade string not configured". Pieter Bakker (surveyor) sees the same strings, but is never in one.

TF-2026-0001 also carries **ETA notices**, one per contract, each seen only by its two parties:
Cerrado's to Lacustra (acknowledged), Lacustra's to Nordlys (awaiting Sanne de Vries) and
Nordlys's to Rhine Valley (overdue: Katrin Vogel can still acknowledge it, late). Claire Morel sees
the first two, from opposite sides, and can issue another notice to Nordlys. Jonas Weber, her
viewer colleague, sees the same but cannot act. Pieter Bakker sees no notices at all, and the
panel says why. Notice times are relative to when the seed ran, so these states hold after a
fresh `pnpm db:seed`.

No **documentary instructions** are seeded. To try them on TF-2026-0001, sign in as Claire Morel
(Lacustra buys under contract 1) and give instructions to Cerrado, then sign in as Ana Souza to
acknowledge the revision. Revise again as Claire in two tabs to see a conflict: the second tab
keeps its draft, shows the newer revision, and sends only after you base the draft on it.
Once instructions are given, Ana Souza (Cerrado sells under contract 1) can upload a PDF for each
document the current revision requires, and replace it; Claire Morel can download every version,
and approve or reject the latest one (a rejection needs a reason). Ana sees each decision on the
version it was made on, and a replacement goes back to Claire as pending. Decide as Claire while
Ana replaces the file in another tab to see a conflict: each side is told whether a new file or a
decision came first, and keeps what it had chosen or typed.
By default, uploaded bytes are kept in `apps/api/var/documents` (`DOCUMENT_STORAGE_DIR`); opt-in
S3 storage and paired recovery are described in the [runbook](docs/storage-recovery.md). Re-seeding removes
instructions and documents on the seeded voyages, and the documents' stored bytes.

API docs are at <http://localhost:3000/api/docs>.

> The demo password is public. Never run the seed against a database holding real users.

> Postgres is published on **5433**, not 5432, so it does not clash with a locally installed
> Postgres. Change the port in `docker-compose.yml` and `apps/api/.env` if needed. Check that
> 5433 is free first: something else may already listen there. The test commands fall back to
> `localhost:5433` too; to verify without depending on it, use a throwaway server and explicit
> `TEST_DATABASE_URL` and `E2E_DATABASE_URL`
> ([handoff](docs/handoff.md#verification-against-isolated-postgresql-only)).

### Everyday commands

| Command            | What it does                                                |
| ------------------ | ----------------------------------------------------------- |
| `pnpm dev`         | Contracts watcher, API (watch mode) and Vite dev server     |
| `pnpm test`        | All tests. API integration tests need `pnpm db:up`          |
| `pnpm lint`        | ESLint with type-aware rules across the monorepo            |
| `pnpm typecheck`   | `tsc --noEmit` in every package                             |
| `pnpm build`       | Production builds of contracts, API and web                 |
| `pnpm check`       | CI's verify job: format, lint, typecheck, test, build       |
| `pnpm test:e2e`    | Browser smoke tests in Chromium (CI's e2e job, not `check`) |
| `pnpm demo`        | A fresh, isolated demo until Ctrl+C; nothing is kept        |
| `pnpm demo:verify` | Walkthrough 2 in Chromium on a fresh demo (CI's demo job)   |
| `pnpm db:reset`    | Drop, re-migrate and re-seed the development database       |

Package-scoped variants: `pnpm --filter @tradeflow/api test:unit` (no database needed),
`pnpm --filter @tradeflow/api test:integration`.

### End-to-end smoke tests

`pnpm test:e2e` needs `pnpm db:up` and, once per machine, Playwright's Chromium:
`pnpm --filter @tradeflow/e2e exec playwright install chromium`. Each run then owns everything
it uses and releases it at the end, whether the tests pass or fail:

- a dedicated database, `tradeflow_e2e` on the same Postgres server (`E2E_DATABASE_URL` to
  change it; the name must end in `_e2e`), dropped, recreated with the real migrations, and
  dropped again afterwards. The development and integration-test databases are never touched;
- a temporary directory with the API build, the production web build and the document storage;
- the API and `vite preview` (with the same-origin `/api` proxy) on ports the operating system
  picks, so a running `pnpm dev` on 3000 and 5173 is neither reused nor stopped.

Server logs, failure screenshots and the HTML report go to `e2e/.output/` (ignored by Git).
Traces, videos and saved browser state are off: they would record the session cookie.

In CI the suite is a job of its own (`e2e` in `.github/workflows/ci.yml`), beside `verify`: a
fresh runner with its own PostgreSQL 18 service, `E2E_DATABASE_URL` pointing at
`tradeflow_e2e` on it, and Chromium installed with its system libraries
(`playwright install --with-deps chromium`). A failing test fails the job; there are no
retries. On failure the job is set up to upload `e2e/.output/` (server logs, failure
screenshots, the HTML report; nothing there records headers or cookies) as the
`e2e-diagnostics` artifact, kept for seven days. No failing run has exercised that upload yet.

A third job, `demo`, runs `pnpm demo:verify` on its own runner. It has no database service: the
demo starts its own PostgreSQL 18 container on the runner's Docker daemon and removes it
afterwards. It installs Chromium the same way, has no retries, and on a failing walkthrough
uploads `e2e/.output/demo/` as `demo-diagnostics`, with the same exclusions. The job passed on `d00635f` in hosted Linux CI ([MVP status](docs/mvp-status.md#verification-at-a-glance)).

### How tests work

- **contracts**: schema behaviour (decimal strings, UUIDs, enums), including the create-voyage
  rules: exact quantities within `DECIMAL(14,3)`, ordered laycan, distinct ports, no extra fields.
  The trade-string schema accepts only trade roles and positive positions. Notice requests
  accept only instants with an offset, a deadline not after the arrival, a bounded message, and
  nothing the server decides (issuer, times, status). Instruction content is bounded (party
  details, one to eight requirements, each document once, counts 0..10, not both zero) and
  closed to server-decided fields.
- **api, unit**: pure mapping logic (decimal precision, calendar dates, participant ordering),
  the trade-string chain rules (gaps, disconnected contracts, branches, cycles, wrong roles at
  either end or in between, service providers as counterparties, empty strings), the notice
  deadline, overdue and lateness rules, unchanged-revision detection, `If-Match` parsing, the
  validation pipe's field paths, the counterparty predicate, password hashing,
  session tokens and cookies, and config validation.
- **api, integration**: boots the real Nest application against the real `tradeflow_test`
  database and asserts every response against the shared Zod contract. The global setup applies
  migrations and **refuses to run against a database whose name does not end in `_test`**.
  Authentication and authorization are tested here end to end: sign-in, expiry, revocation,
  sign-out, sign-in admission (a budget per connecting address that alternating emails and
  forged forwarding headers do not escape, window ends to the millisecond on a hand-moved clock,
  the concurrency cap held on a table lock and freed after failures, 429s that leave sessions
  alone), and the participation rules (shared voyages, isolation, status filters,
  client-supplied organization ids, removed participation, 404 for non-participants). Voyage
  creation is tested there too: 401 and 403, roles re-read on every request, validation without
  partial writes, exactly one audit event, rollback when the audit write fails, and unique,
  consecutive references under concurrent creation. The trade string: ordered topology for every
  participant, the same 404 for outsiders as for a missing voyage, exactly the topology fields in
  the response, a 500 for a stored chain that breaks the domain rules, and the `trade_contracts`
  constraints hit with plain SQL (cross-voyage counterparties, duplicate positions, self-sales,
  branches). Trade-string setup: a voyage created through the API, set up, then used
  for instructions, an upload and a review; viewers, outsiders (identical 404s) and
  non-exporters refused; schema and chain errors, a failed contract insert and a failed audit
  write leaving nothing behind; identical and different chains racing on a held lock (one 200,
  one 409, the winner's rows, one event); a session revoked, a role demoted or an organization
  changed while the setup waits for the lock; seeded and configured voyages unchanged; every
  conditional header (`If-Match`, `If-None-Match` lists read per RFC 9110, commas inside tags included, `If-Unmodified-Since`, malformed); the timeline
  entry without its parties. Organization search: operators only, at most 20, never the
  caller's own, wildcards taken literally. Notices: seller and buyer operators and viewers, every other participant and
  outsiders (identical 404s), cross-voyage and foreign ids, spoofed actors, deadline rules,
  derived overdue and late acknowledgement, immutability and constraints with plain SQL, a forced
  audit failure on issue and on acknowledgement, two acknowledgements made to race on a held row
  lock (one 200, one 409, one event), and an unchanged trade-string response. Documentary
  instructions: every precondition outcome (428, 412, 409, malformed headers), the buyer/seller
  and operator/viewer rules, identical 404s for everyone else, a role removed or an organization
  changed between read and write, immutable revisions and the aggregate's transition rules with
  plain SQL, the requirements CHECK, a forced audit failure on each command, and four real races
  on held locks (two creations, two revisions, two acknowledgements, revision against
  acknowledgement), each ending in one success and one 412. Documents: real multipart uploads
  and downloads against a temporary storage directory (byte-for-byte, with checksums), size and
  type refusals, file names that try to be paths, who may upload and read, superseded revisions
  before the upload and at commit, racing uploads, an abandoned upload, a session, role or
  organization changed while the file arrives, and storage, audit and compensation failures, with
  the database rows and the files on disk checked after each. Document reviews: approval and
  rejection with server-side actors, closed bodies and bounded reasons, who may decide and read,
  every precondition outcome, replaced, already-decided and superseded versions, history kept
  across replacements, a forced audit failure, the tables' rules with plain SQL, and real races
  (review against review, against a replacement in both orders, against a revision of the
  instructions in both orders). The review migrations are applied to a populated scratch database
  and checked for their backfill and for drift from the Prisma schema. The timeline: who sees
  which events, exactly the fields of each entry and none of the recorded contents, full pages
  despite hidden events, equal times split across pages, and cursors confined to the bearer's
  scope. Event streams, over real HTTP connections: who receives which signal (counterparties
  only; not other participants or other voyages) and only its type, for notices, documentary
  instructions, uploads and reviews (no ids, file names, checksums, storage keys or reasons);
  nothing for refused, failed-precondition or rolled-back commands, nor for an upload whose
  commit has an unknown outcome (its bytes kept for reconciliation); one signal when two
  acknowledgements, two revisions of one version, two first uploads or two reviews race, and
  only the winner's when a review races a replacement, in both orders; a committed command that
  succeeds although publishing fails, its files still kept and downloadable byte for byte;
  streams closed after sign-out, revocation, expiry, a change
  of organization or of participation, cleanup on disconnect and on shutdown.
- **web**: renders the real route tree with real providers. Only the network is faked, by MSW, and
  unhandled requests fail the test. Auth flows run against a stateful fake of the auth API,
  including sign-out during an in-flight request, switching users, a change made in another
  tab, and a 429 that keeps what was typed and sends nothing by itself. The voyage form is tested for success, validation, failures, viewers, and a response that
  arrives after the identity changed. The trade string is tested for contract order with several
  traders (against both name and response order), the empty state, its own error and retry, and a
  response whose edges name unlisted parties. Its setup form: who is offered it and why not,
  the exporter fixed first, search from two characters without the caller's own organization,
  at most ten in all, add, remove and labelled moves with focus kept and changes announced, the
  review of roles and contracts, one plain POST with no precondition header, 400 refusals on
  their rows, a failure re-sent only on request, 409s that show the recorded string or say why
  setup is unavailable, a 401, and late outcomes after the same user signs back in or session
  checks go to someone else and back. The notice panel is tested for listing, issuing
  (local times sent as instants), acknowledging, validation, refusals, a 409, failures without
  retries, session expiry, and responses that arrive after the identity changed. The instruction
  panel is tested for both sides and roles, the preconditions each write sends, validation, a 412
  on revising and on creating (draft kept, nothing re-sent until the user rebases), a newer
  version arriving while editing, a failed refresh with a draft open, an acknowledgement overtaken
  by a revision, expiry, and late responses after an identity change. Documents: the multipart
  request each upload sends, files refused before sending, a chosen file kept through refusals,
  failures and a 412, downloads saved under their name, expiry, and upload and download responses
  after an identity change. Reviews: what each side and role is offered, the decision and
  `If-Match` each review sends, conflicts that tell a new file from a decision for both sides,
  cache ordering by document version, and late responses after the same user signs back in or
  after session checks or another tab go to someone else and back. The timeline: every kind of
  event, paging, failures, and pages cancelled by an identity change. Live updates, with a fake
  `EventSource` driven by hand (simulated transport): refetching only the current identity's
  queries a signal concerns (notices, instructions or documents, and the timeline) and all four
  on every (re)connection, with reads of their own even while the first reads are still on their
  way; signals of every kind arriving during a refresh read each resource once more, losing none;
  documents shown as uploads, decisions and replacements are pushed, with every earlier version
  and its decision; an open instruction draft, a chosen file and a decision being made each kept
  with its basis while changes are pushed (nothing sent, re-based, re-targeted or downloaded),
  and no conflict shown when the user's own revision, upload or decision is signalled before its
  response; polling
  only while disconnected and visible, reopening a stream the browser gave up on, closing on unmount, and
  late events ignored after a sign-out, a same-user sign-in, and session checks going to someone
  else and back. The suite runs in `America/Sao_Paulo` time so date- and time-shifting bugs show up.
- **e2e** (`pnpm test:e2e`, Chromium only): eight smoke journeys against the real web build, API
  and PostgreSQL, through the same-origin `/api` proxy, with real sign-in and the browser's own
  `EventSource`. (1) Sign in through the form, reload, stay signed in: the cookie is `HttpOnly`
  and `SameSite=Strict`, invisible to scripts, and the reload is confirmed by the server from it
  alone. (2) A seller and a buyer in separate browser contexts: the seller issues a notice, the
  buyer's notice panel and timeline show it, the buyer acknowledges, the seller's page shows who
  did. (3) Two tabs of one context sign out and back in, as the same user and then as another:
  both tabs follow, protected content disappears, each old stream is closed by the page and at
  the API, and a new one opens. (4) Recovery: a page catches up after its stream is dropped,
  and connects again after a first stream answered 503; a probe records what Chromium's own
  `EventSource` does in each case (`CLOSED` after a 503, reconnecting by itself after a drop,
  honouring the server's `retry`). (5) Documentary instructions: the buyer gives them, the
  seller's page shows them and acknowledges, the buyer's page shows who did, and a revision
  reaches the seller; and a revision a colleague sends while the buyer drafts leaves the draft
  and its basis alone (no write sent) until the buyer bases it on the newer version. (6)
  Documents: the seller uploads a PDF through the form, the buyer's page shows it, the buyer
  downloads it through the browser (the same bytes, by SHA-256) and approves it; a replacement
  reaches the buyer and the rejection of it reaches the seller, each with the earlier version and
  its approval still in the history, and no write or download sent by the page receiving them.
  (7) Trade-string setup, from two organizations and their operators only: the exporter creates
  a voyage through the form, finds the buyer by name, reviews and sets up the string; the buyer,
  in its own context, finds the voyage in its list with the string, its timeline entry and its
  contract, and gives instructions that reach the exporter's page. (8) The Action Center
  ([ADR 0017](docs/decisions/0017-action-center.md#browser-coverage)): instructions, an upload,
  a rejection, a replacement and an approval, each made through the voyage page's forms, reach
  the other organization's queue by its 30-second polling (never Refresh); each item opens its
  exact record, focused below the header, and sends nothing; an ETA notice is acknowledged from
  the queue; an old link to a replaced file opens it as history, and **Show it** reopens every
  fold around it; viewers get no command, and a surveyor and an outsider see no action. That a stream message, not polling, refreshed a page is read off the browser's own network log
  (DevTools protocol, observation only): the stream was open throughout, nothing was refetched
  between a quiet point and the message, exactly the queries that message concerns were
  refetched after it, and moving the
  page's timers past the 30 s fallback interval sent nothing. Faults are injected only by a
  transport proxy between the web server and the API, and labelled as such: a 503 it answers
  itself, stream requests it holds, streams it ends. EventSource, authentication, data and
  stream messages are never faked.
- **Not covered:** HTTPS, so the `Secure` attribute and the `__Host-` cookie name used in
  production (the E2E run is plain HTTP on `127.0.0.1`); browsers other than Chromium, whose
  `EventSource` and cookie handling may differ; layout, including the responsive trade string
  and the notice, instruction and document panels; the browser's own `datetime-local` picker
  (the E2E tests type into it), its file picker and how it saves a download.

## Roadmap

1. **Identity and tenant isolation (done, Milestone 2).** Sign-in, sessions, participation-scoped
   voyage access. Since: an in-process sign-in budget and concurrency cap (ADR 0018). Still open:
   a sign-in limit shared between instances, SSO.
   **First business write (done, Milestone 3).** Voyage creation with viewer/operator roles,
   transactional audit events and server-assigned references.
2. **Trade string (read-only, Milestone 4).** Ordered sale contracts between adjacent parties,
   validated as a linear chain and visible to participants as topology. Done since: the
   one-time setup of a new voyage's chain from its page, with an operator-only organization
   search (ADR 0016). Next: correcting a chain, and contract details visible only to each
   contract's two counterparties.
3. **Notices and documentary instructions.** ETA notices done (Milestone 5): counterparty-only,
   issued and acknowledged with an audit trail. Documentary instructions done (Milestone 6):
   immutable revisions, per-revision acknowledgement, optimistic concurrency with `If-Match`.
   Next: further notice types, notifications.
4. **Documents.** First slice done (Milestone 7): private PDF upload against an exact
   instruction revision, immutable versions, counterparty-only downloads, local storage behind an
   interface. Buyer review done (Milestone 8): one final decision per exact file version, a
   rejection with its reason. Next: S3-compatible storage and pre-signed uploads, a scheduled
   orphan sweep, amending decisions.
5. **Workflow, tasks and deadlines; real-time updates (SSE); background jobs and transactional outbox.**
   Started: a read-only voyage timeline of audit events, and live updates of notices,
   documentary instructions and documents over a per-voyage SSE stream, in process and best
   effort. Next: an outbox and a shared bus for durable, multi-instance delivery.
6. **AI-assisted document extraction and comparison**, with human approval for any critical action.

See [docs/architecture.md](docs/architecture.md#evolution) for how the current design leaves room
for each step.
