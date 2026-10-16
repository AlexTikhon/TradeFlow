# Domain model

## Vocabulary

| Term                         | Meaning in TradeFlow                                                                                                                      |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Voyage**                   | The execution record of one cargo moving on one vessel from a load port to a discharge port. The root object everything else attaches to. |
| **Organization**             | A company using TradeFlow. The tenancy boundary.                                                                                          |
| **User**                     | A person acting on behalf of exactly one organization.                                                                                    |
| **Session**                  | A signed-in browser session of one user. Expires after a fixed lifetime; ends early on sign-out.                                          |
| **Participant**              | An organization taking part in a specific voyage, in a specific role.                                                                     |
| **Role**                     | What an organization does _on that voyage_: exporter, trader, final buyer (trade parties); surveyor, shipping agent (service providers).  |
| **Trade string**             | The chain of sale contracts linking the exporter to the final buyer through any intermediate traders.                                     |
| **ETA notice**               | The seller's statement, under one sale contract, of when the vessel is expected; the buyer acknowledges receiving it.                     |
| **Documentary instructions** | The buyer's instructions to its seller, under one sale contract, on whom the shipping documents name and which documents to present.      |
| **Revision**                 | One complete, unchangeable version of a contract's documentary instructions, numbered 1, 2, 3.                                            |
| **Consignee**                | The party a bill of lading is made out to (often "to order of" a bank); it may take delivery of the cargo.                                |
| **Notify party**             | Whom the carrier notifies when the vessel arrives; usually the buyer or its agent.                                                        |
| **Counterparty**             | The seller or the buyer under a given sale contract.                                                                                      |
| **Laycan**                   | "Lay days / cancelling": the date window in which the vessel must present at the load port. Drives deadlines.                             |
| **IMO number**               | Permanent 7-digit vessel identifier with a check digit.                                                                                   |
| **UN/LOCODE**                | 5-character location code (`BRSSZ` = Santos, `NLRTM` = Rotterdam).                                                                        |
| **MT**                       | Metric tonnes.                                                                                                                            |

## Implemented (Milestones 1 to 6)

```
                        ┌──────────────┐
                        │ Organization │◀──── User (n:1) ◀──── Session (n:1)
                        └──────┬───────┘
                               │ 1
                               │
                               │ n
                    ┌──────────┴──────────┐   seller (n:1)   ┌───────────────┐
                    │  VoyageParticipant  │◀─────────────────│ TradeContract │
                    │                     │◀─────────────────│  position     │
                    └──────────┬──────────┘   buyer (n:1)    └───────┬───────┘
                               │ n                                   │ n
                               │                                     │
                               │ 1                                   │ 1
 Vessel ◀── n:1 ──┐     ┌──────┴───────┐                             │
                  └─────│    Voyage    │◀────────────────────────────┘
 Commodity ◀─ n:1 ──────│              │
 Port (load) ◀─ n:1 ────│              │──── n:1 ─▶ Port (discharge)
                        └──────────────┘

 VoyageParticipant.role: EXPORTER | TRADER | FINAL_BUYER | SURVEYOR | SHIPPING_AGENT

 TradeContract 1 ──── n Notice   (issued by a user of the seller, acknowledged by one of the buyer)
 Notice.type: ETA        Notice.status: ISSUED | ACKNOWLEDGED

 TradeContract 1 ──── 0..1 DocumentaryInstruction   (version, currentRevisionNumber)
                               1 ──── n DocumentaryInstructionRevision   (given by the buyer; immutable)
                                              1 ──── 0..1 DocumentaryInstructionAcknowledgement
                                                                         (by the seller; immutable)
```

| Entity                                  | Key fields                                                                                                                                       | Notes                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| `Organization`                          | name, countryCode                                                                                                                                | No role column, by design (see below)                         |
| `User`                                  | organizationId, email (unique, lowercase), fullName, role (`VIEWER` \| `OPERATOR`), passwordHash (argon2id, nullable)                            | No password means cannot sign in                              |
| `Session`                               | userId, tokenHash (SHA-256, unique), createdAt, expiresAt, revokedAt                                                                             | Valid while unexpired and unrevoked                           |
| `Vessel`                                | name, imoNumber (unique)                                                                                                                         | Reference data shared by all tenants                          |
| `Commodity`                             | code (unique), name                                                                                                                              | Reference data                                                |
| `Port`                                  | unLocode (unique), name, countryCode                                                                                                             | Reference data                                                |
| `Voyage`                                | reference (unique, human-readable), status, vessel, commodity, quantity + unit, load and discharge ports, laycan start and end                   |                                                               |
| `VoyageParticipant`                     | voyageId, organizationId, role; unique `(voyage, organization, role)`                                                                            | Also the access-control relation                              |
| `TradeContract`                         | voyageId, position, sellerParticipantId, buyerParticipantId                                                                                      | One sale in the trade string; topology only (ADR 0010)        |
| `Notice`                                | voyageId, tradeContractId, type, status, estimatedArrivalAt, acknowledgementDueAt, message, issuer and issuedAt, acknowledger and acknowledgedAt | Counterparties only; issued content immutable (ADR 0011)      |
| `DocumentaryInstruction`                | voyageId, tradeContractId (unique), version, currentRevisionNumber                                                                               | Counterparties only; changes by conditional update (ADR 0012) |
| `DocumentaryInstructionRevision`        | instructionId, revisionNumber, consignee, notifyParty, requirements (JSON), author and createdAt                                                 | Immutable                                                     |
| `DocumentaryInstructionAcknowledgement` | instructionId, revisionNumber (unique together), acknowledger and acknowledgedAt                                                                 | Immutable; at most one per revision                           |
| `AuditEvent`                            | action, actorUserId, actorOrganizationId, voyageId, occurredAt, payload (JSON object)                                                            | Append-only; see ADR 0009                                     |
| `VoyageReferenceCounter`                | year, lastNumber                                                                                                                                 | Hands out `TF-<year>-<number>`                                |

### Creating a voyage (initial business rule)

An **operator** creates a voyage for **their own organization**:

- The creating organization becomes the voyage's **`EXPORTER`** participant, and it is the only
  participant at first. This is a deliberately simple starting rule: in this product the exporter
  opens the shipment record, and traders, buyers and service providers join it later (not
  implemented yet). A trader-initiated voyage would need a different rule.
- Every voyage starts **`PLANNED`**.
- The **reference** is assigned by the server: `TF-<year>-<number>`, numbered per UTC calendar
  year, at least four digits, unique and without gaps (a failed creation gives its number back).
- The client sends only shipment facts: vessel, commodity, quantity, load and discharge ports, and
  laycan. Organization, participants, status, reference, actor and timestamps are never accepted
  from it; a body that contains them is rejected.
- Input rules: the quantity is an exact positive decimal string that fits `DECIMAL(14,3)` (at most
  11 digits before the point and 3 after; more precision is an error, never rounded); the laycan
  ends on or after its start; the ports differ; vessel, commodity and ports exist.
- The voyage, its participation and one `VOYAGE_CREATED` audit event are written in one
  transaction (ADR 0009).

### Voyage status

`PLANNED → LOADING → IN_TRANSIT → DISCHARGING → COMPLETED`, with `CANCELLED` reachable from any
non-terminal state. A new voyage always starts `PLANNED`. Transitions are not enforced yet because
no endpoint changes a status. They will live in the voyages module (and later `workflow`), not in
the database.

### Trade string

The trade string is modelled as its **edges**, the sale contracts between adjacent parties, not
as a list of nodes. The commercially meaningful object is the edge: notices will travel from a
seller to its buyer under a specific contract, and confidentiality is per contract. The order of
the parties follows from the contracts' positions; edge data could not be derived from nodes.

```
position:        1                 2                 3
Cerrado ──sells to──▶ Lacustra ──sells to──▶ Nordlys ──sells to──▶ Rhine Valley
EXPORTER              TRADER                 TRADER                FINAL_BUYER
```

A contract names two **participants** of its own voyage (the participant row carries the
organization and its role). Rules are split by what can see them:

| Rule                                                                 | Enforced by                        |
| -------------------------------------------------------------------- | ---------------------------------- |
| Position is positive and unique per voyage                           | Database (CHECK, unique index)     |
| Seller and buyer differ                                              | Database (CHECK)                   |
| Seller and buyer participate in the contract's voyage                | Database (composite foreign keys)  |
| A participant sells at most once and buys at most once (no branches) | Database (unique indexes)          |
| Positions run 1..n without gaps                                      | Domain (`voyages/trade-string.ts`) |
| Each buyer is the next contract's seller                             | Domain                             |
| No organization appears twice (no cycles, also across its roles)     | Domain                             |
| Exporter sells first, final buyer buys last, traders in between      | Domain                             |
| Surveyors and shipping agents are never counterparties               | Domain                             |

The domain rules are a plain walk along the position-ordered contracts, not a graph library. An
**empty** string is valid: a newly created voyage has no contracts. Not every trade party has to
be in the string either: a trader may have joined before its contract is recorded.

No endpoint records or edits contracts yet; the demo seed writes them, after checking them with
the same domain rules. The API validates the stored chain again when it reads it, and answers a
broken one with a generic 500 instead of presenting it as valid.

**Visibility** ([ADR 0010](decisions/0010-trade-string-visibility.md)): every participant of the
voyage, service providers included, may read the topology: parties in order and who sells to
whom. Commercial terms and the parties' own contract references are not part of that view, and
participation grants no access to them when they are added.

### ETA notices

A notice travels from the **seller** to the **buyer** under one sale contract. Milestone 5 has one
type (`ETA`) and one workflow:

```
           seller's operator issues               buyer's operator acknowledges (once)
 (none) ─────────────────────────▶  ISSUED  ─────────────────────────────────────────▶  ACKNOWLEDGED
                                      │
                                      └─ overdue: derived while ISSUED and past the deadline
```

- **Acknowledging records receipt, not commercial acceptance.** The buyer confirms it was told;
  it agrees to nothing.
- **Who** ([ADR 0011](decisions/0011-counterparty-notices.md)): users of the contract's seller
  and buyer organizations read its notices; an `OPERATOR` of the seller issues; an `OPERATOR` of
  the buyer acknowledges. The organization must be a counterparty **and** still participate in
  the voyage. Everyone else, including service providers and traders elsewhere in the string,
  gets the same 404 as for a notice that does not exist. What decides is the organization's
  side of the contract, not its participant role: a trader is the buyer under one contract and
  the seller under the next.
- **What a notice holds:** the estimated arrival and the acknowledgement deadline (instants), an
  optional message of at most 1000 characters, and who issued it, for which organization, and
  when. Once acknowledged: who, for which organization, and when. People and times come from the
  session and the server's clock, never from the request.
- **Issued content never changes.** There is no editing; a changed ETA is a new notice.

**MVP business rules for time** (a starting point, not settled commercial practice):

1. The acknowledgement deadline lies after the moment of issue and not after the estimated
   arrival.
2. A notice is **overdue** while it is `ISSUED` and its deadline has passed. Overdue is derived on
   every read, never stored, and nothing runs when a deadline passes.
3. The buyer may **acknowledge late**. A late acknowledgement is recorded like any other; the
   notice stops being overdue, and its times (and its audit event) show it was late.

### Documentary instructions

Documentary instructions travel the other way: from the **buyer** to the **seller** under one sale
contract ([ADR 0012](decisions/0012-documentary-instructions.md)). They tell the seller whom the
shipping documents must name and which documents to present.

```
                 buyer's operator                  buyer's operator
 (none) ──── gives revision 1 ────▶ revision 1 ──── revises ────▶ revision 2 ──── ... ────▶ revision n
                                       │                             │
                     seller's operator acknowledges     seller's operator acknowledges
                     receipt of revision 1 (once)       receipt of revision 2 (once)
```

- **One instruction per contract.** It is an aggregate of **revisions**; each revision is the
  complete content, never changes once written, and is numbered 1, 2, 3 without gaps. Revising
  writes the next revision and makes it current; earlier revisions stay as they were.
- **Acknowledgement names the exact revision** and records receipt, not acceptance. Only the
  current revision can be acknowledged, and only once. A new revision starts unacknowledged;
  the acknowledgements of earlier revisions remain, so it is always clear which content the
  seller confirmed.
- **Who:** users of the contract's buyer and seller read them, viewers included, with every
  revision; an `OPERATOR` of the buyer gives and revises them; an `OPERATOR` of the seller
  acknowledges. The organization must be a counterparty and still participate in the voyage.
  Everyone else gets the same 404 as for instructions that do not exist. As for notices, the
  side of the contract decides, not the participant role.
- **Version versus revision.** The aggregate's **version** advances on every change, a revision
  or an acknowledgement; the **revision number** advances only with content. Every write names
  the version it was based on (HTTP `If-Match`; `If-None-Match: *` for the first instructions)
  and fails with 412 if anything changed since, so nobody overwrites, or acknowledges, content
  they have not seen.
- **People and times** come from the session and the server's clock, never from the request.

**MVP business rules** (project-specific starting points, not settled commercial practice):

1. **Content** is a consignee (free text, at most 500 characters: name and address lines), an
   optional notify party (the same bounds), and **one to eight document requirements**. A
   requirement names one of eight document types (bill of lading, commercial invoice,
   certificate of origin, phytosanitary, weight, quality, fumigation or insurance certificate)
   and asks for 0 to 10 originals and 0 to 10 copies, at least one in total. Each type appears
   at most once per revision. Nothing else yet: no free-text clauses, presentation deadlines,
   bank details or attachments.
2. **Only the buyer writes.** The seller cannot propose changes through the system; it
   acknowledges, or talks to the buyer.
3. **A revision must change something.** Re-sending the current content is refused: it would
   only reset the seller's acknowledgement.
4. **Nothing is withdrawn or deleted.** Instructions are corrected by revising them.

### Invariants enforced by the database

- `quantity > 0`
- `laycan_end >= laycan_start`
- `load_port_id <> discharge_port_id`
- Format checks: IMO (7 digits), UN/LOCODE, ISO country codes, lowercase email.
- `password_hash` is an argon2id PHC string; `token_hash` is exactly 32 bytes;
  `expires_at > created_at`.
- `audit_events` is append-only (a trigger refuses `UPDATE` and `DELETE`), holds a JSON object
  payload, and has at most one `VOYAGE_CREATED` per voyage.
- Reference counters: a four-digit year and a non-negative last number.
- Trade contracts: `position > 0` and unique per voyage; `seller_participant_id <>
buyer_participant_id`; both reference participants of the same voyage (foreign keys on
  `(voyage_id, participant_id)`); each participant sells and buys at most once per voyage; a
  participant named by a contract cannot be deleted.
- Notices: belong to a contract of their own voyage (foreign key on
  `(voyage_id, trade_contract_id)`); `issued_at < acknowledgement_due_at <= estimated_arrival_at`;
  a message is at most 1000 characters and not blank; the acknowledging user, organization and
  time are set exactly when the status is `ACKNOWLEDGED`, and not before the time of issue. A
  trigger refuses changes to issued content and any change to an acknowledged notice. A contract
  with notices cannot be deleted. Audit events allow one `NOTICE_ISSUED` and one
  `NOTICE_ACKNOWLEDGED` per notice.
- Documentary instructions: one per contract, inside its voyage (foreign key on
  `(voyage_id, trade_contract_id)`); created at version 1 with revision 1; every change advances
  the version by exactly one and the revision number by at most one; the current revision never
  exceeds the version and exists at commit. Revisions and acknowledgements are inserted only for
  the current revision and never updated; one acknowledgement per revision. Consignee and notify
  party are bounded and not blank; requirements are one to eight well-formed entries, each
  document once. A contract with instructions cannot be deleted. Audit events allow one event
  per instruction version, one `DOCUMENTARY_INSTRUCTION_REVISED` per revision and one
  `DOCUMENTARY_INSTRUCTION_ACKNOWLEDGED` per revision.

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
example, Trader B must not see the price Trader A paid the exporter) is a further refinement. The
first rule of that kind is [ADR 0010](decisions/0010-trade-string-visibility.md): participants
see who sells to whom, never contract terms.

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

**Current state (Milestone 6).** Every signed-in user can read exactly the voyages their
organization participates in, including each voyage's trade-string topology, and the notices and
documentary instructions under the contracts their organization is a party to. Users have one of
two roles ([ADR 0008](decisions/0008-user-roles.md)): a **viewer** only reads; an **operator** may
also create voyages for their organization, issue or acknowledge notices, and give, revise or
acknowledge documentary instructions for it. The role is on
the user row, which is organization-scoped because a user belongs to exactly one organization,
and it is read on every request. Creating a voyage needs no participant role, since the voyage
does not exist yet; the creator becomes its exporter. Notice commands are the first commands on
existing voyages and check both layers in their service: the organization's side of the
contract (a domain rule: only the seller issues, only the buyer acknowledges), and the user's
role within their organization. Documentary instructions check the same two layers, with the
sides reversed: the buyer writes, the seller acknowledges.

## Proposed next (not implemented)

### Confidential contract data and recording the string

`TradeContract` holds topology only (see [Trade string](#trade-string)). Next steps, none built:

- **Recording and editing the string** through the API, with the domain validation above run
  inside the writing transaction and an audit event per change (ADR 0009). Who may do it (the
  exporter's operators? each seller for its own sale?) is still open.
- **Contract details** (each side's contract reference, terms) as a separate object visible only
  to that contract's two counterparties, with its own endpoint and schema. ADR 0010 explicitly
  does not cover it.

### Voyage versus cargo

A real vessel can carry several parcels belonging to different trade strings. Today `Voyage` holds
exactly one cargo (commodity and quantity). If multi-parcel voyages become a requirement, the split
is `Voyage 1 ── n Cargo`, with trade strings, notices and documents moving to `Cargo`. This was
deliberately not modelled yet: it adds a join to every query for a case nothing currently needs.

### Further entities

| Entity                         | Shape (sketch)                                                               |
| ------------------------------ | ---------------------------------------------------------------------------- |
| Further notice types           | vessel nomination, notice of readiness; same direction and visibility as ETA |
| `Document` / `DocumentVersion` | file metadata and storage key; immutable versions                            |
| `Task`                         | due date (often derived from laycan), assignee organization, status          |
