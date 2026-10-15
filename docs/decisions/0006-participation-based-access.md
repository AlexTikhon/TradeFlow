# 0006. Participation-based access to voyages

- **Status:** Accepted. Data model in place; enforcement arrives with authentication (Milestone 2).
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
- When authentication lands, every voyage query takes the acting organization and filters with
  `participants: { some: { organizationId } }`. Requests for a voyage the organization does not
  participate in return **404, not 403**, so the existence of other parties' voyages is not
  disclosed.
- Finer-grained visibility inside a voyage (contract-level confidentiality along the trade string)
  is layered on top, per object type.

## Alternatives considered

- **Owner tenant plus sharing grants** (`voyages.owner_organization_id` plus an ACL table).
  Familiar, but it creates a privileged owner, which the business does not have: an exporter and
  a final buyer are peers on the shipment.
- **Duplicating the voyage per tenant**, each organization holding its own copy. Simple isolation,
  but it destroys the single shared source of truth that is the point of the product, and needs
  synchronisation.
- **Postgres RLS as the primary mechanism.** Strong guarantees, but policies over a join table,
  combined with Prisma's connection handling, add complexity. Kept as a candidate for defence in
  depth once application-level scoping exists and is tested.

## Consequences

- Isolation is one well-indexed join that is easy to test: integration tests will assert that a
  non-participant gets 404 for every voyage-scoped endpoint.
- Every new voyage-scoped query must apply the scope. To make that hard to forget, the scope will be
  built by a single function (or a Prisma client extension) rather than repeated per query.
- Removing a participant immediately revokes access. Audit records must therefore capture what an
  organization saw or did while it was a participant.
