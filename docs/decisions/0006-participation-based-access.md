# 0006. Participation-based access to voyages

- **Status:** Accepted. Enforced since Milestone 2 for every voyage endpoint.
- **Date:** 2026-10-15

## Context

TradeFlow is multi-tenant: each organization is a tenant. Unlike typical SaaS, the core object is
**shared across tenants**. A voyage involves the exporter, one or more traders, the final buyer and
service providers, and all of them must see it. The classic pattern (`tenant_id` on every row,
filter by it, optionally enforce with Postgres RLS) does not fit, because a voyage has no single
owner tenant.

## Decision

Access to a voyage, and to everything attached to it, is derived from **participation**:

> An organization may access a voyage if and only if a `voyage_participants` row links it to that
> voyage.

- `voyage_participants(organization_id, voyage_id)` is indexed for the access query.
- Organizations carry no role. The role is per participation (see the
  [domain model](../domain-model.md#1-roles-belong-to-participation-not-to-organizations)).
- The acting organization comes from the authenticated session
  ([ADR 0007](0007-cookie-sessions.md)), never from the request.
- The rule is written once, as the Prisma predicate `accessibleVoyages(principal)` in
  `modules/voyages/voyage-access.ts`. Every voyage query combines it with its own filters using
  `AND`, so authorization happens **inside the database query**. A filter cannot widen it, and a
  row the organization may not see is never loaded.
- Requests for a voyage the organization does not participate in return **404, not 403**, with a
  body identical to that for a nonexistent voyage, so the existence of other parties' voyages is
  not disclosed.
- Finer-grained visibility inside a voyage (contract-level confidentiality along the trade string)
  is layered on top, per object type. The first such rule is
  [ADR 0010](0010-trade-string-visibility.md): participants see the trade string's topology, but
  not contract terms. The second is [ADR 0011](0011-counterparty-notices.md): notices are
  visible only to their contract's two counterparties, who must still participate.

## Alternatives considered

- **Owner tenant plus sharing grants** (`voyages.owner_organization_id` plus an ACL table).
  Familiar, but it creates a privileged owner, which the business does not have: an exporter and
  a final buyer are peers on the shipment.
- **Duplicating the voyage per tenant**, each organization holding its own copy. Simple isolation,
  but it destroys the single shared source of truth that is the point of the product, and needs
  synchronisation.
- **Postgres RLS as the primary mechanism.** Strong guarantees, but policies over a join table,
  combined with Prisma's connection handling, add complexity. Kept as a candidate for defence in
  depth now that application-level scoping exists and is tested.
- **Load, then check in code** (`findUnique` followed by an `if`). Easy to forget, and it reads
  rows the caller may not see. Rejected in favour of the query predicate.

## Consequences

- Isolation is one well-indexed semi-join (`EXISTS` over `voyage_participants`) that is easy to
  test. Integration tests against real PostgreSQL assert that each organization sees only its
  voyages, that status filters and client-supplied organization ids cannot widen the scope, and
  that a non-participant gets the same 404 as for a missing voyage.
- Every new voyage-scoped query must use `accessibleVoyages`. Notices, documents and other
  voyage children will reach their voyage through it rather than restating the rule.
- Removing a participant revokes access on the very next request, because the predicate is
  evaluated per query and nothing caches it. Audit records must therefore capture what an
  organization saw or did while it was a participant.
- Participation decides **which voyages** an organization sees. It says nothing about **what a
  given user may do** there; see the
  [domain model](../domain-model.md#6-user-permissions-are-not-participant-roles).
