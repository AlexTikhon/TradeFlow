# Architecture Decision Records

Lightweight ADRs for decisions that had real alternatives. Each records the context, the
decision, and the consequences we accept. A superseded ADR stays in place, marked as superseded,
with a link to its replacement.

| #    | Decision                                                                                                                   | Status                                       |
| ---- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| 0001 | [Modular monolith instead of microservices](0001-modular-monolith.md)                                                      | Accepted                                     |
| 0002 | [pnpm workspace monorepo](0002-pnpm-monorepo.md)                                                                           | Accepted                                     |
| 0003 | [Server state in TanStack Query; no global store yet](0003-frontend-server-state.md)                                       | Accepted                                     |
| 0004 | [PostgreSQL with Prisma](0004-postgresql-and-prisma.md)                                                                    | Accepted                                     |
| 0005 | [Shared Zod schemas as the API contract](0005-shared-zod-api-contract.md)                                                  | Accepted                                     |
| 0006 | [Participation-based access to voyages](0006-participation-based-access.md)                                                | Accepted (enforced since Milestone 2)        |
| 0007 | [Server-side sessions in an HttpOnly cookie](0007-cookie-sessions.md)                                                      | Accepted                                     |
| 0008 | [Two user roles, VIEWER and OPERATOR, on the user row](0008-user-roles.md)                                                 | Accepted                                     |
| 0009 | [Audit events written in the same transaction as the action](0009-transactional-audit-events.md)                           | Accepted                                     |
| 0010 | [Trade-string topology is visible to every voyage participant (MVP)](0010-trade-string-visibility.md)                      | Accepted                                     |
| 0011 | [ETA notices: counterparty-only, issued then acknowledged, overdue derived (MVP)](0011-counterparty-notices.md)            | Accepted                                     |
| 0012 | [Documentary instructions: revisioned per contract, conditional writes with ETags (MVP)](0012-documentary-instructions.md) | Accepted                                     |
| 0013 | [Documents: private PDF versions per instruction revision, received outside the transaction (MVP)](0013-documents.md)      | Accepted (concurrency token amended by 0014) |
| 0014 | [Document review: one final decision per file version, a document version for every change (MVP)](0014-document-review.md) | Accepted                                     |
| 0015 | [Voyage event streams: SSE invalidation signals, in-process and best effort (MVP)](0015-voyage-event-streams.md)           | Accepted                                     |
| 0016 | [Initial voyage setup: one atomic command records a new voyage's whole trade chain](0016-initial-voyage-setup.md)          | Accepted                                     |
| 0017 | [Action Center: a read-only projection of what each organization owes, across voyages](0017-action-center.md)              | Proposed (endpoint and web page)             |

Template: **Context** (forces at play), **Decision**, **Alternatives considered**,
**Consequences** (good and bad).
