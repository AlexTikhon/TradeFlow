# 0009. Audit events written in the same transaction as the action

- **Status:** Accepted
- **Date:** 2026-10-15

## Context

Voyage creation is the first action that changes shared business data, and every party to a
shipment may later need to know who did what, for which organization, and when. ADR 0006 already
notes that access is evaluated per request, so the audit trail must record what an organization
did while it was a participant. The forces:

- **No action without its record, and no record without its action.** An audit trail that can
  miss events, or record events that were rolled back, cannot be relied on.
- **The actor cannot be client-supplied.** It is whoever the session belongs to.
- **Append-only.** History is not edited, by the API or by anyone with database access through
  an application role.
- **One database today** (ADR 0004). There is no broker, and no outbox yet.

## Decision

**An `audit_events` table, written by the `audit` module through the caller's transaction.**

| Column                  | Meaning                                                                                                                                            |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `action`                | Enum `audit_action`: `VOYAGE_CREATED`; since Milestone 5 also `NOTICE_ISSUED` and `NOTICE_ACKNOWLEDGED` ([ADR 0011](0011-counterparty-notices.md)) |
| `actor_user_id`         | The authenticated principal's user                                                                                                                 |
| `actor_organization_id` | The organization they acted for, as resolved for that request                                                                                      |
| `voyage_id`             | The subject                                                                                                                                        |
| `occurred_at`           | Set by the API when the event is written                                                                                                           |
| `payload`               | JSON object of action-specific facts; for creation, the voyage as created                                                                          |

- `AuditTrail.record(tx, event)` only accepts a Prisma transaction client, so an event cannot be
  written outside the action's transaction. It takes the actor as a `Principal`, never as request
  data.
- **Atomicity:** the voyage, its participation and the event are written in one interactive
  transaction. If the event insert fails, the whole creation rolls back, its reference number
  included, and the client gets a generic 500. An integration test forces that failure with a
  database trigger and asserts that nothing remains.
- **Append-only, in the database:** a trigger refuses `UPDATE` and `DELETE` on `audit_events`
  for every writer. Foreign keys to users, organizations and voyages are `RESTRICT`, so audited
  rows cannot be deleted from under their events. A partial unique index allows at most one
  `VOYAGE_CREATED` per voyage.
- No endpoint reads, edits or deletes events yet. A voyage timeline is a later feature.

## Alternatives considered

- **Database triggers that write the audit row.** Atomic, but a trigger does not know the
  principal unless it is smuggled in through session variables, which interact badly with
  connection pooling.
- **Logging (application logs or a log pipeline).** Not transactional with the change, so events
  can be lost or describe rolled-back work. Logs stay operational, not evidential.
- **Event sourcing.** The audit trail would be the source of truth, but it changes how every
  aggregate is stored and queried. Far more than this milestone needs.
- **An outbox now.** Needed once events must leave the database (notifications, real-time
  updates). The audit table can later feed it, or the outbox row can be written in the same
  transaction alongside it.

## Consequences

- Every future command calls `AuditTrail.record` inside its transaction. Adding an action means
  adding an `audit_action` value and deciding what its payload records.
- Seeded demo voyages have no creation event: they were loaded, not created by anyone.
- `TRUNCATE` is not blocked (it is used to reset the test database). Hardening for production
  means a separate database role for the application without `TRUNCATE` or trigger privileges.
- `occurred_at` comes from the API's clock, as all other timestamps written through Prisma do.
  It is never accepted from a client.
