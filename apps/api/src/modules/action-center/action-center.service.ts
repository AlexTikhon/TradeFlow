import { Inject, Injectable } from '@nestjs/common';
import {
  ACTION_ITEMS_DEFAULT_PAGE_SIZE,
  type ActionItemPage,
  type ActionItemsQuery,
} from '@tradeflow/contracts';
import { RequestValidationException } from '../../common/http/request-validation.exception.js';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import type { Principal } from '../auth/principal.js';
import { CurrentRevisions } from '../documentary-instructions/current-revisions.js';
import { LatestDocumentVersions } from '../documents/latest-document-versions.js';
import { IssuedNotices } from '../notices/issued-notices.js';
import { CounterpartyContracts } from '../voyages/counterparty-contracts.js';
import { actionItemPage, decodeActionItemCursor } from './action-item-pages.js';
import type { ActionItemPosition, ContractFacts } from './action-items.js';
import { toContractFacts } from './contract-facts.js';

/** The API's clock. A provider of its own, so tests can stand exactly at a deadline. */
export const ACTION_CENTER_CLOCK = Symbol('ACTION_CENTER_CLOCK');
export type Clock = () => Date;

/**
 * The organization's open actions, a page at a time (ADR 0017). Owns no table: the scope comes
 * from the voyages module, every fact from the module that owns it, and the rules from
 * `action-items.ts`. Nothing is written.
 *
 * Every page loads the organization's candidate facts in scope (issued notices, current
 * revisions, latest files of current-revision documents), projects them and cuts the page in
 * memory. The response is bounded by `limit`; the loading grows with the organization's current
 * work, never with its history. No total is counted.
 */
@Injectable()
export class ActionCenterService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly contracts: CounterpartyContracts,
    private readonly notices: IssuedNotices,
    private readonly revisions: CurrentRevisions,
    private readonly documents: LatestDocumentVersions,
    @Inject(ACTION_CENTER_CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * One page for the principal's organization, which comes from the session alone. A cursor
   * the API did not issue is refused (400) before anything is read, the same for everyone.
   *
   * The scope and every fact come from one REPEATABLE READ snapshot, so a command committed
   * between two of the reads cannot leave the page half before and half after it. A read-only
   * transaction cannot fail serialization. The clock is read once: it decides `overdue` and is
   * served as `generatedAt`.
   */
  async page(principal: Principal, query: ActionItemsQuery): Promise<ActionItemPage> {
    const after = query.cursor === undefined ? undefined : parseCursor(query.cursor);
    const { contracts, now } = await this.prisma.$transaction(
      async (tx) => ({ contracts: await this.load(principal, tx), now: this.clock() }),
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    return actionItemPage(
      contracts,
      principal.organizationId,
      {
        type: query.type,
        overdue: query.overdue,
        after,
        limit: query.limit ?? ACTION_ITEMS_DEFAULT_PAGE_SIZE,
      },
      now,
    );
  }

  /**
   * The facts under every contract in scope: one query per kind of record, however many
   * voyages, contracts, revisions or documents there are. Documents are read for the revisions
   * that the instruction read found current, in the same snapshot.
   */
  private async load(principal: Principal, tx: Prisma.TransactionClient): Promise<ContractFacts[]> {
    const contracts = await this.contracts.listAcrossVoyages(principal, tx);
    if (contracts.length === 0) {
      return [];
    }
    const notices = await this.notices.listUnderContracts(
      contracts.map(({ id, voyage }) => ({ voyageId: voyage.id, contractId: id })),
      tx,
    );
    const revisions = await this.revisions.listUnderContracts(
      contracts.map(({ id }) => id),
      tx,
    );
    const documents = await this.documents.listForRevisions(
      revisions.map(({ contractId, revisionNumber }) => ({ contractId, revisionNumber })),
      tx,
    );
    return toContractFacts({ contracts, notices, revisions, documents });
  }
}

function parseCursor(cursor: string): ActionItemPosition {
  const position = decodeActionItemCursor(cursor);
  if (!position) {
    throw new RequestValidationException([
      { path: 'query.cursor', message: 'Expected a cursor from a previous page' },
    ]);
  }
  return position;
}
