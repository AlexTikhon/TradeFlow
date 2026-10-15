# Architecture Decision Records

Lightweight ADRs for decisions that had real alternatives. Each records the context, the
decision, and the consequences we accept. A superseded ADR stays in place, marked as superseded,
with a link to its replacement.

| #    | Decision                                                                             | Status                                |
| ---- | ------------------------------------------------------------------------------------ | ------------------------------------- |
| 0001 | [Modular monolith instead of microservices](0001-modular-monolith.md)                | Accepted                              |
| 0002 | [pnpm workspace monorepo](0002-pnpm-monorepo.md)                                     | Accepted                              |
| 0003 | [Server state in TanStack Query; no global store yet](0003-frontend-server-state.md) | Accepted                              |
| 0004 | [PostgreSQL with Prisma](0004-postgresql-and-prisma.md)                              | Accepted                              |
| 0005 | [Shared Zod schemas as the API contract](0005-shared-zod-api-contract.md)            | Accepted                              |
| 0006 | [Participation-based access to voyages](0006-participation-based-access.md)          | Accepted (enforced since Milestone 2) |
| 0007 | [Server-side sessions in an HttpOnly cookie](0007-cookie-sessions.md)                | Accepted                              |

Template: **Context** (forces at play), **Decision**, **Alternatives considered**,
**Consequences** (good and bad).
