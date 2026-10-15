# 0010. Trade-string topology is visible to every voyage participant (MVP)

- **Status:** Accepted
- **Date:** 2026-10-15

## Context

Milestone 4 records each voyage's trade string: the sale contracts that carry one cargo from the
exporter, through any traders, to the final buyer. A contract is a commercial relationship
between exactly two organizations, and most of what it holds is confidential to them: the price,
payment and delivery terms, and each side's own contract reference. Trader B must not learn what
Trader A paid the exporter.

Yet the shipment is shared ([ADR 0006](0006-participation-based-access.md)). Notices and
documents pass along the string, and each party, as well as the surveyor and shipping agent
working for them, needs to know where it sits: who it buys from and who it sells to.

So the question this milestone has to answer is narrower than "who may see a contract": **who may
see that a contract exists between two parties, and in which order?** No terms or references are
stored yet; the decision must still leave room for them without leaking them later.

## Decision

**Every participant of a voyage may read the trade string's topology, and nothing more.**

`GET /api/voyages/:voyageId/trade-string` returns:

| Part      | Fields                                                    | Meaning                                            |
| --------- | --------------------------------------------------------- | -------------------------------------------------- |
| `parties` | `organization` (`id`, `name`, `countryCode`), `role`      | Exporter first, then each trader, final buyer last |
| `edges`   | `position`, `sellerOrganizationId`, `buyerOrganizationId` | Who sells to whom, and where in the string         |

- **Who:** the same rule as for the voyage itself. The service `AND`s
  `accessibleVoyages(principal)` into the one query that loads the string, so a non-participant
  gets the same 404 as for a missing voyage. Service providers may read it too.
- **Excluded, deliberately:** commercial terms (price, quantity per contract, payment and delivery
  terms), the parties' own contract references, and internal identifiers (contract and
  participant row ids, timestamps). The response is built from an explicit Prisma select and a
  closed mapping (`trade-string.read-model.ts`), so a column added to `trade_contracts` later is
  not exposed unless someone selects it on purpose. An integration test pins the exact field set.
- **Participation is not a grant for contract data.** This ADR covers topology only. Being a
  participant does **not** entitle an organization to any confidential contract data added
  later. Each such field will need its own visibility rule, decided when it is introduced and
  most likely limited to the contract's two counterparties, served by a separate endpoint and
  response schema rather than by widening this one.

## Alternatives considered

- **Counterparty-only visibility** (each organization sees only its own seller and buyer).
  Closest to a strict need-to-know reading, but a trader could not tell how long the string is or
  where notices will come from, and service providers would see nothing. It can be layered on
  later for voyages that need it, as a per-voyage policy, without changing the data model.
- **No trade-string visibility until contract permissions exist.** Safe, but it blocks the
  operational value of the feature and would postpone a decision that does not depend on contract
  terms at all.
- **One contract resource with field-level filtering per viewer.** One endpoint, but every new
  field would have to remember to be filtered, and the default would be to leak. Separate,
  allowlisted responses fail closed instead.

## Consequences

- Every participant, including surveyors and shipping agents, learns which organizations trade
  the cargo and in which order. Some trading houses treat even their supplier's identity as
  sensitive; if that becomes a requirement, the counterparty-only policy above is the fallback.
- The trade string has its own response schema (`TradeString` in `packages/contracts`), separate
  from any future contract-details schema, so the shared view cannot grow by accident.
- Future confidential contract fields need a new ADR or an amendment that says who sees them.
  This one must not be cited as allowing it.
- Access is still evaluated per request: an organization removed from a voyage stops seeing its
  string on the next request, like the voyage itself.
