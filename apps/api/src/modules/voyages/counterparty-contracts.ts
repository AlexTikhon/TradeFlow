import { Injectable } from '@nestjs/common';
import type { CounterpartyContract, OrganizationRef } from '@tradeflow/contracts';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import type { Principal } from '../auth/principal.js';
import { accessibleVoyages } from './voyage-access.js';

/*
 * Sale contracts as their counterparties see them (ADR 0011). The voyages module owns
 * `trade_contracts` and `voyage_participants`, so this is the only way other modules (notices)
 * resolve a contract: they never query those tables themselves.
 */

/**
 * The contracts the principal's organization may act on as a counterparty: it is the seller or
 * the buyer under the contract, and it currently participates in the contract's voyage
 * (ADR 0006). The composite foreign keys make the first imply the second today; the predicate
 * states both so it does not depend on them.
 */
export function counterpartyContracts(principal: Principal): Prisma.TradeContractWhereInput {
  return {
    AND: [
      { voyage: accessibleVoyages(principal) },
      {
        OR: [
          { seller: { organizationId: principal.organizationId } },
          { buyer: { organizationId: principal.organizationId } },
        ],
      },
    ],
  };
}

const organizationSelect = { select: { id: true, name: true, countryCode: true } } as const;

/** The allowlist of what a counterparty sees of its contract. */
const counterpartyContractSelect = {
  id: true,
  position: true,
  seller: { select: { organization: organizationSelect } },
  buyer: { select: { organization: organizationSelect } },
} satisfies Prisma.TradeContractSelect;

type CounterpartyContractRow = Prisma.TradeContractGetPayload<{
  select: typeof counterpartyContractSelect;
}>;

function toCounterpartyContract(
  principal: Principal,
  row: CounterpartyContractRow,
): CounterpartyContract {
  return {
    id: row.id,
    position: row.position,
    side: row.seller.organization.id === principal.organizationId ? 'SELLER' : 'BUYER',
    seller: row.seller.organization,
    buyer: row.buyer.organization,
  };
}

/**
 * A contract in scope across voyages, for the Action Center (ADR 0017): its voyage by id and
 * reference, and both counterparties. The side follows from comparing them with the reader's
 * organization.
 */
export interface ContractInScope {
  id: string;
  position: number;
  voyage: { id: string; reference: string };
  seller: OrganizationRef;
  buyer: OrganizationRef;
}

const contractInScopeSelect = {
  ...counterpartyContractSelect,
  voyage: { select: { id: true, reference: true } },
} satisfies Prisma.TradeContractSelect;

/** Database access these reads accept: the service's client, or a caller's transaction. */
type Db = Prisma.TransactionClient;

@Injectable()
export class CounterpartyContracts {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The voyage's contracts the principal's organization is a party to, in position order. Null
   * when the voyage does not exist or the organization does not participate in it (the same
   * answer, from one query); empty when it participates but is a party to no contract.
   */
  async listForVoyage(
    principal: Principal,
    voyageId: string,
    db: Db = this.prisma,
  ): Promise<CounterpartyContract[] | null> {
    const voyage = await db.voyage.findFirst({
      where: { AND: [{ id: voyageId }, accessibleVoyages(principal)] },
      select: {
        tradeContracts: {
          where: counterpartyContracts(principal),
          select: counterpartyContractSelect,
          orderBy: { position: 'asc' },
        },
      },
    });
    return voyage && voyage.tradeContracts.map((row) => toCounterpartyContract(principal, row));
  }

  /**
   * One contract of the voyage, if the principal's organization is a party to it. Null alike
   * for a missing contract, a contract of another voyage, and someone else's contract.
   */
  async findForVoyage(
    principal: Principal,
    voyageId: string,
    contractId: string,
    db: Db = this.prisma,
  ): Promise<CounterpartyContract | null> {
    const row = await db.tradeContract.findFirst({
      where: { AND: [{ id: contractId, voyageId }, counterpartyContracts(principal)] },
      select: counterpartyContractSelect,
    });
    return row && toCounterpartyContract(principal, row);
  }

  /**
   * Every contract the principal's organization is a party to, on every voyage it participates
   * in, from one query: the predicate selects them in the database, so no other voyage or
   * contract is read. Ordered by voyage and position, for a stable read; callers order their own
   * results. Reads through `db`, so a caller's later reads share its snapshot.
   */
  async listAcrossVoyages(principal: Principal, db: Db): Promise<ContractInScope[]> {
    const rows = await db.tradeContract.findMany({
      where: counterpartyContracts(principal),
      select: contractInScopeSelect,
      orderBy: [{ voyageId: 'asc' }, { position: 'asc' }],
    });
    return rows.map((row) => ({
      id: row.id,
      position: row.position,
      voyage: row.voyage,
      seller: row.seller.organization,
      buyer: row.buyer.organization,
    }));
  }
}
