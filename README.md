# TradeFlow

TradeFlow is a B2B platform for the **post-trade execution of bulk commodity shipments**: the
operational work that happens after a cargo of soybeans, corn or wheat has been sold, often
several times over, between the exporter and the final buyer.

```
Exporter ──sells to──▶ Trader A ──sells to──▶ Trader B ──sells to──▶ Final buyer
                    one physical cargo, one vessel, many commercial relationships
```

Every party in that chain works on the same physical shipment, but each has separate contracts,
documents and obligations. TradeFlow models that shared workspace. Today that means voyages and the
organizations taking part in them. Next come notices, documentary instructions, documents,
approvals and an audit trail.

> This is an engineering portfolio project. It is inspired by real commodity-shipping workflow
> problems, but it is not a clone of any commercial product, and all organizations and people in the
> demo data are fictional.

## Status: Milestone 1 (first vertical slice)

| Area    | Delivered                                                                                                            |
| ------- | -------------------------------------------------------------------------------------------------------------------- |
| API     | `GET /api/voyages` (with `?status=` filter), `GET /api/voyages/:voyageId`, `GET /api/health`, OpenAPI at `/api/docs` |
| Web     | Voyage list (status filter kept in the URL), voyage details with participating organizations                         |
| Data    | PostgreSQL 18 schema with DB-enforced invariants and an idempotent demo seed (7 voyages, 12 organizations)           |
| Quality | Strict TypeScript, type-aware ESLint, Prettier, 46 automated tests, GitHub Actions CI                                |

Authentication, tenancy enforcement, notices, documents, real-time updates and AI features are
**intentionally not built yet**. See [Roadmap](#roadmap).

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

Details: [docs/architecture.md](docs/architecture.md) · Domain:
[docs/domain-model.md](docs/domain-model.md) · Decisions: [docs/decisions/](docs/decisions/)

## Repository layout

```
apps/
  api/                 NestJS API
    prisma/            schema, migrations, demo seed
    src/
      modules/         domain modules (voyages, ...)
      common/http/     problem details, validation pipe, OpenAPI wiring
      infrastructure/  Prisma client
      config/          validated environment config
    test/              integration tests (real PostgreSQL)
  web/                 React SPA
    src/
      app/             shell: providers, routes, layout, theme
      features/        one folder per domain feature (voyages/{api,domain,components,pages})
      shared/          cross-feature api client, ui, formatting
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

Open <http://localhost:5173>. API docs are at <http://localhost:3000/api/docs>.

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

- **contracts**: schema behaviour (decimal strings, UUIDs, enums).
- **api, unit**: pure mapping logic (decimal precision, calendar dates, participant ordering) and
  config validation.
- **api, integration**: boots the real Nest application against the real `tradeflow_test`
  database and asserts every response against the shared Zod contract. The global setup applies
  migrations and **refuses to run against a database whose name does not end in `_test`**.
- **web**: renders the real route tree with real providers. Only the network is faked, by MSW, and
  unhandled requests fail the test. The suite runs in `America/Sao_Paulo` time so date-shifting
  bugs show up.

## Roadmap

1. **Identity and tenant isolation (next).** Users sign in; every query is scoped to voyages the
   user's organization participates in; non-participants get 404s; basic roles.
2. **Trade string.** Ordered sale contracts between adjacent parties.
3. **Notices and documentary instructions.** Versioned, directional business objects with
   optimistic concurrency and an audit trail.
4. **Documents.** Object storage, versions, access checks.
5. **Workflow, tasks and deadlines; real-time updates (SSE); background jobs and transactional outbox.**
6. **AI-assisted document extraction and comparison**, with human approval for any critical action.

See [docs/architecture.md](docs/architecture.md#evolution) for how the current design leaves room
for each step.
