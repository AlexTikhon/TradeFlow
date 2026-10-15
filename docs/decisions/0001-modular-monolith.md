# 0001. Modular monolith instead of microservices

- **Status:** Accepted
- **Date:** 2026-10-15

## Context

TradeFlow has several domain areas (voyages, trade strings, notices, documents, workflow,
messaging, audit, AI). The domain is still being discovered: boundaries that look right today
(is a notice part of the trade string or its own context?) will move. Most operations span
several areas inside one business transaction. For example, accepting a notice updates the notice,
writes an audit event and creates follow-up tasks, and all three must commit or fail together.

There is one team and no requirement for independent scaling or independent deployment.

## Decision

Build a **single NestJS application** with explicit domain modules under `src/modules/`. Modules
expose providers to each other and do not reach into each other's tables. Cross-cutting technical
code lives in `common/` and `infrastructure/`.

## Alternatives considered

- **Microservices from day one.** Independent deployability and scaling, but distributed
  transactions (sagas, outbox everywhere), network failure modes on every call, duplicated
  infrastructure and contract versioning between services, all before we know where the stable
  boundaries are. Getting boundaries wrong across a network is far more expensive than inside a
  process.
- **Unstructured monolith (layered by technical type: controllers/, services/, entities/).**
  Fast to start, but domain boundaries erode silently and nothing could ever be extracted.

## Consequences

- Business operations use ordinary database transactions: one ACID commit for the notice, the
  audit event and the tasks.
- One deployable, one database, simple local development and debugging.
- Boundaries are enforced by convention and review, not by the network. If they start to erode,
  add a lint rule (import restrictions between modules).
- Extraction remains possible: a module with no direct table access from other modules, and whose
  events go through the (future) transactional outbox, can become a service when there is a
  concrete reason such as independent scaling of AI document processing.
