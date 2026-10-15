# 0008. Two user roles, VIEWER and OPERATOR, on the user row

- **Status:** Accepted
- **Date:** 2026-10-15

## Context

Milestone 3 adds the first business write: creating a voyage. Until now every signed-in user could
do exactly one thing, read the voyages their organization participates in
([ADR 0006](0006-participation-based-access.md)). A write needs a second question answered: may
**this user** act for their organization? (See
[domain model §6](../domain-model.md#6-user-permissions-are-not-participant-roles): participation
decides which voyages, user permissions decide what a person may do.)

The forces:

- **A user belongs to exactly one organization** (`users.organization_id`). There is no
  membership table, and nothing yet needs one.
- **One write exists.** Later ones (notices, instructions, documents) will need finer
  distinctions, but nobody knows which yet.
- **Permission changes must apply at once.** Revoking someone's right to write must not wait for
  their session to expire, as with organization changes today.
- **Least privilege.** A new or migrated user should be able to read, not write.

## Decision

**A `role` column on `users`, enum `user_role` with two values: `VIEWER` (default) and
`OPERATOR`.**

| Role       | May                                                                    |
| ---------- | ---------------------------------------------------------------------- |
| `VIEWER`   | Read the voyages their organization participates in                    |
| `OPERATOR` | Everything a viewer may, plus change them (today: create voyages only) |

- Because a user belongs to one organization, a role on the user row **is** organization-scoped:
  it says what the user may do on behalf of that organization, and nothing else.
- `AuthGuard` reads the role from the user row on every request, in the same query that validates
  the session, and puts it on the `Principal`. The session row stores nothing about it, so a role
  change takes effect on the user's next request.
- **The service that performs a command checks the role**, by name
  (`requireOperator(principal, 'create voyages')` in `modules/auth/user-permissions.ts`), before
  doing anything else. A refusal is `403` Problem Details. Controllers and guards do not decide
  it, so a command cannot be reached by another route without its check.
- `GET /api/auth/me` returns the role, so the UI can hide actions the user may not take. The UI
  check is a convenience only; the API check is authoritative.
- Validation runs before the service, so a viewer who sends an invalid body gets `400`, not `403`.
  The validation rules are public (OpenAPI), so this reveals nothing.

## Alternatives considered

- **A generic RBAC engine** (roles, permissions, role-permission tables, policy evaluation). It
  answers questions nobody is asking yet, and every check becomes a lookup in data that tests
  must set up. Rejected until there are enough distinct permissions to justify it.
- **A membership table** `(user, organization, role)` now. It is the right shape once a user can
  act for several organizations (a consultant, a group company), but today it would duplicate
  `users.organization_id` and invite the two to disagree.
- **Roles in the session** (copied at sign-in). Cheaper per request, but a demoted user would keep
  writing until their session expired.
- **Participant roles as permissions** ("exporters may create"). Conflates what an organization
  does on a voyage with what a person may do for it; see the domain model.

## Consequences

- One indexed lookup per request, which already happened for the organization.
- A test asserts that promoting and demoting a user changes the outcome of their next request
  with the same session.
- Existing users became `VIEWER` when the column was added. The demo seed makes one user per
  organization an operator and keeps two viewers.
- **When a user can belong to several organizations**, the role moves to a membership table keyed
  by `(user, organization)`, and the principal carries the role for the organization the user is
  acting for. `requireOperator` keeps its signature.
- **When writes need finer distinctions** (for example, accepting a nomination but not creating
  voyages), add a role or a named permission check next to `requireOperator`. Business rules that
  depend on the organization's participant role on a voyage are separate checks in the same
  service.
