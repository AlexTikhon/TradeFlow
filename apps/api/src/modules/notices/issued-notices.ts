import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';

/*
 * Notices still waiting for the buyer, as the Action Center needs them (ADR 0017). This module
 * owns `notices`, so this is the only way another module reads them. Callers pass contracts they
 * have already resolved for the principal through `CounterpartyContracts`; nothing here checks
 * who is asking.
 */

/** A contract to read under, with its voyage (the notices' index leads with the voyage). */
export interface NoticeContract {
  voyageId: string;
  contractId: string;
}

/** An ETA notice that is still ISSUED: no acknowledgement yet. */
export interface IssuedNotice {
  id: string;
  contractId: string;
  issuedAt: Date;
  acknowledgementDueAt: Date;
}

@Injectable()
export class IssuedNotices {
  /**
   * The ISSUED notices under `contracts`, from one query. Acknowledged notices are filtered out
   * in the database, and only the columns an action is made of are read: never the message or
   * who issued it. Reads through `db`, so the caller's snapshot decides what is still issued.
   */
  async listUnderContracts(
    contracts: readonly NoticeContract[],
    db: Prisma.TransactionClient,
  ): Promise<IssuedNotice[]> {
    if (contracts.length === 0) {
      return [];
    }
    const rows = await db.notice.findMany({
      where: {
        // A notice's voyage is its contract's (a composite foreign key), so the voyage filter
        // only lets the index narrow the rows; the contract ids alone decide which are read.
        voyageId: { in: [...new Set(contracts.map(({ voyageId }) => voyageId))] },
        tradeContractId: { in: contracts.map(({ contractId }) => contractId) },
        status: 'ISSUED',
      },
      select: { id: true, tradeContractId: true, issuedAt: true, acknowledgementDueAt: true },
    });
    return rows.map(({ tradeContractId, ...notice }) => ({
      ...notice,
      contractId: tradeContractId,
    }));
  }
}
