# Architecture Decision Records

Lightweight ADRs for decisions that had real alternatives. Each records the context, the
decision, and the consequences we accept. A superseded ADR stays in place, marked as superseded,
with a link to its replacement.

| #    | Decision                                                                                                                   | Status                                |
| ---- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| 0001 | [Modular monolith instead of microservices](0001-modular-monolith.md)                                                      | Accepted                              |
| 0002 | [pnpm workspace monorepo](0002-pnpm-monorepo.md)                                                                           | Accepted                              |
| 0003 | [Server state in TanStack Query; no global store yet](0003-frontend-server-state.md)                                       | Accepted                              |
| 0004 | [PostgreSQL with Prisma](0004-postgresql-and-prisma.md)                                                                    | Accepted                              |
| 0005 | [Shared Zod schemas as the API contract](0005-shared-zod-api-contract.md)                                                  | Accepted                              |
| 0006 | [Participation-based access to voyages](0006-participation-based-access.md)                                                | Accepted (enforced since Milestone 2) |
| 0007 | [Server-side sessions in an HttpOnly cookie](0007-cookie-sessions.md)                                                      | Accepted                              |
| 0008 | [Two user roles, VIEWER and OPERATOR, on the user row](0008-user-roles.md)                                                 | Accepted                              |
| 0009 | [Audit events written in the same transaction as the action](0009-transactional-audit-events.md)                           | Accepted                              |
| 0010 | [Trade-string topology is visible to every voyage participant (MVP)](0010-trade-string-visibility.md)                      | Accepted                              |
| 0011 | [ETA notices: counterparty-only, issued then acknowledged, overdue derived (MVP)](0011-counterparty-notices.md)            | Accepted                              |
| 0012 | [Documentary instructions: revisioned per contract, conditional writes with ETags (MVP)](0012-documentary-instructions.md) | Accepted                              |

Template: **Context** (forces at play), **Decision**, **Alternatives considered**,
**Consequences** (good and bad).
