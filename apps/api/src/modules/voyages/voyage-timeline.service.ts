import { Injectable } from '@nestjs/common';
import {
  TIMELINE_DEFAULT_PAGE_SIZE,
  type VoyageTimelinePage,
  type VoyageTimelineQuery,
} from '@tradeflow/contracts';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { AuditTimeline, parseTimelineCursor } from '../audit/audit-timeline.js';
import type { Principal } from '../auth/principal.js';
import { CounterpartyContracts } from './counterparty-contracts.js';

/**
 * A voyage's timeline as the principal's organization may see it. The voyages module decides
 * who sees what, since it owns participation and contracts; the audit module reads the events.
 * The voyage's creation is visible to every current participant; an event under a sale contract
 * only to that contract's current counterparties (ADR 0011), exactly as the notice, instruction
 * and document reads decide it.
 */
@Injectable()
export class VoyageTimelineService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly contracts: CounterpartyContracts,
    private readonly timeline: AuditTimeline,
  ) {}

  /**
   * One page, newest first. Null alike when the voyage does not exist and when the organization
   * does not participate in it. A cursor that the API did not issue is refused (400) before
   * anything is read, whatever the voyage.
   *
   * Visibility and events come from one REPEATABLE READ snapshot: a contract or participation
   * change committed between the two queries cannot let through an event the scope, read a
   * moment earlier, would no longer allow. A read-only transaction cannot fail serialization.
   */
  async page(
    principal: Principal,
    voyageId: string,
    query: VoyageTimelineQuery,
  ): Promise<VoyageTimelinePage | null> {
    const after = query.cursor === undefined ? undefined : parseTimelineCursor(query.cursor);
    const limit = query.limit ?? TIMELINE_DEFAULT_PAGE_SIZE;
    return this.prisma.$transaction(
      async (tx) => {
        const contracts = await this.contracts.listForVoyage(principal, voyageId, tx);
        if (!contracts) {
          return null;
        }
        return this.timeline.page(
          tx,
          { voyageId, contracts: contracts.map(({ id, position }) => ({ id, position })) },
          { after, limit },
        );
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}
