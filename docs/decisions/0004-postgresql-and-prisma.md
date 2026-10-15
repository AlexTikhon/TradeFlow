# 0004. PostgreSQL with Prisma

- **Status:** Accepted
- **Date:** 2026-10-15

## Context

The data is relational and integrity-sensitive: voyages reference vessels, ports and
organizations; trade strings are ordered relations; audit trails must commit atomically with the
changes they describe. We need migrations, strong typing in TypeScript, and room for row-level
locking, optimistic concurrency and possibly Row-Level Security later.

## Decision

- **PostgreSQL 18.** ACID transactions, rich constraints (CHECK, partial unique indexes), `jsonb`
  for future document extraction payloads, RLS available as defence in depth, and native
  `uuidv7()` for time-ordered primary keys.
- **Prisma 7** as ORM and migration tool, using the `prisma-client` generator (ESM, generated into
  `src/generated`) and the `@prisma/adapter-pg` driver adapter.
- Migrations are SQL files reviewed in pull requests. Invariants Prisma cannot express (CHECK
  constraints) are written by hand into the migration SQL. Prisma's diffing was verified to leave
  them alone.

## Alternatives considered

- **Drizzle ORM.** SQL-like API, thin runtime, excellent for complex queries. A strong
  alternative. Prisma was chosen for its schema-first modelling and migration workflow and because
  it was the stated preference; Drizzle would be the pick if most queries became analytical SQL.
- **TypeORM.** Decorator entities fit Nest's style, but its type safety for query results is
  weaker and its migration generation is less predictable.
- **Kysely or raw SQL.** Maximum control, but we would hand-build migrations and model typing.

## Consequences

- Fully typed queries, including `select` shapes (`VoyageGetPayload<...>`).
- Locking reads (`SELECT ... FOR UPDATE`) and some reporting queries will need `$queryRaw` or
  TypedSQL. Acceptable as isolated escape hatches.
- Optimistic concurrency is implemented manually (`updateMany({ where: { id, version } })` and a
  row-count check); Prisma has no built-in version field.
- If Postgres RLS is adopted for tenant isolation, each request's queries must run in a transaction
  that sets `app.current_organization_id`. Prisma client extensions can do this, at some
  connection-handling cost. To be evaluated in the tenancy milestone.
- Prisma 7 does not auto-load `.env`; `prisma.config.ts` loads it explicitly for local development.
