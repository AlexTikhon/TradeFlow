# Domain model

## Vocabulary

| Term             | Meaning in TradeFlow                                                                                                                      |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Voyage**       | The execution record of one cargo moving on one vessel from a load port to a discharge port. The root object everything else attaches to. |
| **Organization** | A company using TradeFlow. The tenancy boundary.                                                                                          |
| **User**         | A person acting on behalf of exactly one organization.                                                                                    |
| **Session**      | A signed-in browser session of one user. Expires after a fixed lifetime; ends early on sign-out.                                          |
| **Participant**  | An organization taking part in a specific voyage, in a specific role.                                                                     |
| **Role**         | What an organization does _on that voyage_: exporter, trader, final buyer (trade parties); surveyor, shipping agent (service providers).  |
| **Trade string** | The chain of sale contracts linking the exporter to the final buyer through any intermediate traders.                                     |
| **Laycan**       | "Lay days / cancelling": the date window in which the vessel must present at the load port. Drives deadlines.                             |
| **IMO number**   | Permanent 7-digit vessel identifier with a check digit.                                                                                   |
| **UN/LOCODE**    | 5-character location code (`BRSSZ` = Santos, `NLRTM` = Rotterdam).                                                                        |
| **MT**           | Metric tonnes.                                                                                                                            |

## Implemented (Milestones 1 and 2)

```
                        ┌──────────────┐
                        │ Organization │◀──── User (n:1) ◀──── Session (n:1)
                        └──────┬───────┘
                               │ 1
                               │
                               │ n
                    ┌──────────┴──────────┐
                    │  VoyageParticipant  │  role: EXPORTER | TRADER | FINAL_BUYER
                    │                     │        | SURVEYOR | SHIPPING_AGENT
                    └──────────┬──────────┘
                               │ n
                               │
                               │ 1
 Vessel ◀── n:1 ──┐     ┌──────┴───────┐     ┌── n:1 ──▶ Commodity
                  └─────│    Voyage    │─────┘
 Port (load) ◀─ n:1 ────│              │──── n:1 ─▶ Port (discharge)
                        └──────────────┘
```

| Entity              | Key fields                                                                                                                     | Notes                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- |
| `Organization`      | name, countryCode                                                                                                              | No role column, by design (see below) |
| `User`              | organizationId, email (unique, lowercase), fullName, passwordHash (argon2id, nullable)                                         | No password means cannot sign in      |
| `Session`           | userId, tokenHash (SHA-256, unique), createdAt, expiresAt, revokedAt                                                           | Valid while unexpired and unrevoked   |
| `Vessel`            | name, imoNumber (unique)                                                                                                       | Reference data shared by all tenants  |
| `Commodity`         | code (unique), name                                                                                                            | Reference data                        |
| `Port`              | unLocode (unique), name, countryCode                                                                                           | Reference data                        |
| `Voyage`            | reference (unique, human-readable), status, vessel, commodity, quantity + unit, load and discharge ports, laycan start and end |                                       |
| `VoyageParticipant` | voyageId, organizationId, role; unique `(voyage, organization, role)`                                                          | Also the access-control relation      |

### Voyage status

`PLANNED → LOADING → IN_TRANSIT → DISCHARGING → COMPLETED`, with `CANCELLED` reachable from any
non-terminal state. Transitions are not enforced yet because there are no write endpoints. They
will live in the voyages module (and later `workflow`), not in the database.

### Invariants enforced by the database

- `quantity > 0`
- `laycan_end >= laycan_start`
- `load_port_id <> discharge_port_id`
- Format checks: IMO (7 digits), UN/LOCODE, ISO country codes, lowercase email.
- `password_hash` is an argon2id PHC string; `token_hash` is exactly 32 bytes;
  `expires_at > created_at`.

## Modelling decisions

### 1. Roles belong to participation, not to organizations

An organization is an exporter on one voyage and a buyer on another, and a trading house is both
buyer and seller within the same chain. Storing `type = TRADER` on `Organization` would be wrong
almost immediately. The role lives on `VoyageParticipant`, so an organization holds one role per
voyage (the unique key allows several distinct roles if that is ever genuine).

This replaces the `TradeParty` entity from the original brief: a "trade party" is an organization
participating with a trade role, not a separate thing.

### 2. Access is participation-based, not tenant-owned rows

In most multi-tenant SaaS each row belongs to one tenant (`tenant_id`). Here a voyage is
**shared**: every participating organization must see it, and nobody else may. The isolation rule
is therefore:

> An organization can see a voyage if and only if it participates in that voyage.

`voyage_participants` is indexed on `(organization_id, voyage_id)` for exactly this query. It is
enforced on every voyage query by a single predicate, with the organization taken from the
signed-in session. See
[ADR 0006](decisions/0006-participation-based-access.md). Visibility _within_ a voyage (for
example, Trader B must not see the price Trader A paid the exporter) is a further refinement that
arrives with the trade string.

### 3. Quantities are exact decimals, carried as strings

`DECIMAL(14,3)` in Postgres, `Prisma.Decimal` in the API, `"50000.000"` on the wire, and
`Intl.NumberFormat.format("50000.000")` in the UI. No float ever represents a cargo quantity.
Quantities carry their unit (`MT` only for now) so that a future unit never gets silently
misinterpreted.

### 4. Ports and vessels are reference data with real identifiers

Origin and destination are `Port` rows identified by UN/LOCODE rather than free text, so
"Santos", "SANTOS" and "Santos, BR" cannot become three different places. Vessels are identified
by IMO number, which survives renames.

### 5. Calendar dates are not instants

Laycan dates are `date` columns, serialised as `YYYY-MM-DD`, and formatted in UTC on the client.
Timestamps (`createdAt`, `updatedAt`) are `timestamptz` and ISO-8601 instants.

### 6. User permissions are not participant roles

Two different questions, answered by two different mechanisms:

| Question                                             | Answered by                                | Example                                                     |
| ---------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------- |
| **Which voyages** can this organization see?         | Participation (`VoyageParticipant`)        | Lacustra participates in TF-2026-0001, so its users see it  |
| **What role** does the organization play on it?      | The participation's `role`                 | Lacustra is a _trader_ on TF-2026-0001                      |
| **What may this user do** inside their organization? | User permissions (**not implemented yet**) | Only some Lacustra employees may accept a vessel nomination |

A participant role is a business fact about the shipment, visible to every other participant. It
will drive _business_ rules: only the seller under a contract may send a vessel nomination to its
buyer; only a surveyor may upload a quality certificate. A user permission is internal to one
organization: which of its employees may perform those actions on its behalf. Neither implies the
other. A trader's junior analyst sees every voyage the trader participates in but may not be
allowed to accept notices. And when the organization is exporter on one voyage and buyer on
another, its users' permissions do not change between the two.

**Current state (Milestone 2).** Every signed-in user can read exactly the voyages their
organization participates in, and nothing else. The only business endpoints are reads, so there
are no user permissions and no write authorization yet. **Write RBAC is not done** and must not be
assumed. When writes arrive, each command will check both layers in its service: the
organization's participant role on that voyage (a domain rule), and the user's permission within
their organization (a grant on a future organization membership).

## Proposed next (not implemented)

### Trade string as edges, not nodes

The brief suggests `TradeStringNode`. I recommend modelling the **contracts between** adjacent
parties instead:

```
TradeContract
  voyageId
  position          1 = exporter's sale, 2 = next sale, ...
  sellerParticipantId
  buyerParticipantId
  contractReference
```

The commercially meaningful object is the edge. Notices are sent from a seller to its buyer under
a specific contract, documentary instructions flow from a buyer back to its seller, and
confidentiality is per contract. Node order can be derived from the edges; edge data cannot be
derived from nodes.

### Voyage versus cargo

A real vessel can carry several parcels belonging to different trade strings. Today `Voyage` holds
exactly one cargo (commodity and quantity). If multi-parcel voyages become a requirement, the split
is `Voyage 1 ── n Cargo`, with trade strings, notices and documents moving to `Cargo`. This was
deliberately not modelled yet: it adds a join to every query for a case nothing currently needs.

### Further entities

| Entity                         | Shape (sketch)                                                                   |
| ------------------------------ | -------------------------------------------------------------------------------- |
| `Notice`                       | type (e.g. vessel nomination, ETA), from → to along a `TradeContract`, versioned |
| `DocumentaryInstruction`       | buyer → seller, versioned, requires acknowledgement                              |
| `Document` / `DocumentVersion` | file metadata and storage key; immutable versions                                |
| `Task`                         | due date (often derived from laycan), assignee organization, status              |
| `AuditEvent`                   | actor user + organization, action, subject, before/after, timestamp; append-only |
