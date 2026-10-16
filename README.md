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
organizations taking part in them, the trade string, ETA notices from sellers to buyers, and
documentary instructions from buyers to sellers. Next come further notices, documents and
approvals.

> This is an engineering portfolio project. It is inspired by real commodity-shipping workflow
> problems, but it is not a clone of any commercial product, and all organizations and people in the
> demo data are fictional.

## Status: Milestone 6 (documentary instructions)

| Area         | Delivered                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth         | Email + password sign-in (argon2id), server-side sessions in an HttpOnly cookie, `GET /api/auth/me`, sign-out that revokes the session                                                                                                                                                                                                                                                                                                                                                                      |
| Access       | Every voyage query scoped to the voyages the user's organization participates in; non-participants get the same 404 as for a missing voyage                                                                                                                                                                                                                                                                                                                                                                 |
| Roles        | `VIEWER` (read) and `OPERATOR` (read and act) per user, read on every request and checked in the service that performs each command ([ADR 0008](docs/decisions/0008-user-roles.md))                                                                                                                                                                                                                                                                                                                         |
| Writes       | `POST /api/voyages`: starts `PLANNED`, creator's organization becomes `EXPORTER`, server-assigned `TF-<year>-<number>`; issuing and acknowledging notices; giving, revising and acknowledging documentary instructions with `If-Match`/`ETag` (412 when stale, 428 without a precondition). Each command and its audit event commit in one transaction                                                                                                                                                      |
| Trade        | Sale contracts stored as edges (`trade_contracts`), row rules in the database, chain rules (linear, exporter → traders → final buyer) in the domain; every participant sees the topology, never contract ids or terms ([ADR 0010](docs/decisions/0010-trade-string-visibility.md))                                                                                                                                                                                                                          |
| Notices      | ETA notices from the seller to the buyer under one contract, readable only by those two organizations; an operator of the seller issues, an operator of the buyer acknowledges receipt (not acceptance) once, by conditional update; overdue derived from the deadline, late acknowledgement allowed ([ADR 0011](docs/decisions/0011-counterparty-notices.md))                                                                                                                                              |
| Instructions | Documentary instructions from the buyer to the seller under one contract (consignee, notify party, up to eight required documents), counterparty-only; immutable revisions, the seller acknowledges an exact revision, a new revision starts unacknowledged; every write is one conditional SQL statement, so races end in one success and one 412 ([ADR 0012](docs/decisions/0012-documentary-instructions.md))                                                                                            |
| API          | `GET`/`POST /api/voyages`, `GET /api/voyages/:voyageId`, `.../trade-string`, `.../my-contracts`, `GET`/`POST .../notices`, `GET .../notices/:noticeId`, `POST .../notices/:noticeId/acknowledgement`, `GET .../documentary-instructions`, `GET`/`PUT .../contracts/:contractId/documentary-instructions`, `POST .../revisions/:n/acknowledgement`, `GET /api/vessels`, `/commodities`, `/ports`, `/api/auth/*`, `GET /api/health`, OpenAPI at `/api/docs`                                                   |
| Web          | Sign-in, protected routes, user menu; voyage list (status filter in the URL), details with the trade string drawn in contract order and an ETA notice panel (list, issue, acknowledge), a documentary-instruction panel (revisions, form, acknowledgement; a draft survives a conflict and is re-sent only after the user reviews the newer version), and a creation form for operators; cache partitioned by identity and purged on every change; writes never retried and dropped if the identity changed |
| Data         | PostgreSQL 18 schema with DB-enforced invariants (immutable issued notices and instruction revisions, versioned instructions, append-only audit events), and an idempotent demo seed (7 voyages, 6 of them with a trade string, 4 ETA notices, 12 organizations, 14 users)                                                                                                                                                                                                                                  |
| Quality      | Strict TypeScript, type-aware ESLint, Prettier, 551 automated tests (authorization, transactions, races and constraints tested against real PostgreSQL), GitHub Actions CI                                                                                                                                                                                                                                                                                                                                  |

Voyage creation, ETA notices and documentary instructions write data; trade strings come from the
seed and are read-only.
Recording or editing a trade string, editing voyages, adding participants or inviting
organizations, other notice types, editing notices, document uploads, notifications, an audit timeline in
the UI, real-time updates and AI features are **intentionally not built yet**. See
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
docs/                  architecture, domain model, ADRs
docker/                Postgres init scripts
```

## Getting started

**Prerequisites:** Node.js ≥ 24.11, pnpm 11 (`corepack enable` picks up the pinned version),
Docker.

```bash
pnpm install
cp apps/api/.env.example apps/api/.env

pnpm db:up          # PostgreSQL 18 on localhost:5433 (creates tradeflow and tradeflow_test)
pnpm db:migrate     # apply migrations
pnpm db:seed        # load demo data (safe to re-run)

pnpm dev            # API on :3000, web on :5173
```

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
Re-seeding removes instructions on the seeded voyages.

API docs are at <http://localhost:3000/api/docs>.

> The demo password is public. Never run the seed against a database holding real users.

> Postgres is published on **5433**, not 5432, so it does not clash with a locally installed
> Postgres. Change the port in `docker-compose.yml` and `apps/api/.env` if needed.

### Everyday commands

| Command          | What it does                                             |
| ---------------- | -------------------------------------------------------- |
| `pnpm dev`       | Contracts watcher, API (watch mode) and Vite dev server  |
| `pnpm test`      | All tests. API integration tests need `pnpm db:up`       |
| `pnpm lint`      | ESLint with type-aware rules across the monorepo         |
| `pnpm typecheck` | `tsc --noEmit` in every package                          |
| `pnpm build`     | Production builds of contracts, API and web              |
| `pnpm check`     | Everything CI runs: format, lint, typecheck, test, build |
| `pnpm db:reset`  | Drop, re-migrate and re-seed the development database    |

Package-scoped variants: `pnpm --filter @tradeflow/api test:unit` (no database needed),
`pnpm --filter @tradeflow/api test:integration`.

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
  sign-out, and the participation rules (shared voyages, isolation, status filters,
  client-supplied organization ids, removed participation, 404 for non-participants). Voyage
  creation is tested there too: 401 and 403, roles re-read on every request, validation without
  partial writes, exactly one audit event, rollback when the audit write fails, and unique,
  consecutive references under concurrent creation. The trade string: ordered topology for every
  participant, the same 404 for outsiders as for a missing voyage, exactly the topology fields in
  the response, a 500 for a stored chain that breaks the domain rules, and the `trade_contracts`
  constraints hit with plain SQL (cross-voyage counterparties, duplicate positions, self-sales,
  branches). Notices: seller and buyer operators and viewers, every other participant and
  outsiders (identical 404s), cross-voyage and foreign ids, spoofed actors, deadline rules,
  derived overdue and late acknowledgement, immutability and constraints with plain SQL, a forced
  audit failure on issue and on acknowledgement, two acknowledgements made to race on a held row
  lock (one 200, one 409, one event), and an unchanged trade-string response. Documentary
  instructions: every precondition outcome (428, 412, 409, malformed headers), the buyer/seller
  and operator/viewer rules, identical 404s for everyone else, a role removed or an organization
  changed between read and write, immutable revisions and the aggregate's transition rules with
  plain SQL, the requirements CHECK, a forced audit failure on each command, and four real races
  on held locks (two creations, two revisions, two acknowledgements, revision against
  acknowledgement), each ending in one success and one 412.
- **web**: renders the real route tree with real providers. Only the network is faked, by MSW, and
  unhandled requests fail the test. Auth flows run against a stateful fake of the auth API,
  including sign-out during an in-flight request, switching users, and a change made in another
  tab. The voyage form is tested for success, validation, failures, viewers, and a response that
  arrives after the identity changed. The trade string is tested for contract order with several
  traders (against both name and response order), the empty state, its own error and retry, and a
  response whose edges name unlisted parties. The notice panel is tested for listing, issuing
  (local times sent as instants), acknowledging, validation, refusals, a 409, failures without
  retries, session expiry, and responses that arrive after the identity changed. The instruction
  panel is tested for both sides and roles, the preconditions each write sends, validation, a 412
  on revising and on creating (draft kept, nothing re-sent until the user rebases), a newer
  version arriving while editing, a failed refresh with a draft open, an acknowledgement overtaken
  by a revision, expiry, and late responses after an identity change. The suite runs
  in `America/Sao_Paulo` time so date- and time-shifting bugs show up.
- **Not covered:** nothing runs in a real browser yet (web tests use jsdom), so layout, including
  the responsive trade string and the notice and instruction panels, and the browser's own `datetime-local`
  picker are not verified automatically. Playwright end-to-end tests are planned.

## Roadmap

1. **Identity and tenant isolation (done, Milestone 2).** Sign-in, sessions, participation-scoped
   voyage access. Still open: sign-in rate limiting, SSO.
   **First business write (done, Milestone 3).** Voyage creation with viewer/operator roles,
   transactional audit events and server-assigned references.
2. **Trade string (read-only, Milestone 4).** Ordered sale contracts between adjacent parties,
   validated as a linear chain and visible to participants as topology. Next: recording and
   editing it through the API, and contract details visible only to each contract's two
   counterparties.
3. **Notices and documentary instructions.** ETA notices done (Milestone 5): counterparty-only,
   issued and acknowledged with an audit trail. Documentary instructions done (Milestone 6):
   immutable revisions, per-revision acknowledgement, optimistic concurrency with `If-Match`.
   Next: further notice types, notifications.
4. **Documents.** Object storage, versions, access checks.
5. **Workflow, tasks and deadlines; real-time updates (SSE); background jobs and transactional outbox.**
6. **AI-assisted document extraction and comparison**, with human approval for any critical action.

See [docs/architecture.md](docs/architecture.md#evolution) for how the current design leaves room
for each step.
