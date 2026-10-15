import { Injectable } from '@nestjs/common';
import type { TradeString } from '@tradeflow/contracts';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import type { Principal } from '../auth/principal.js';
import { accessibleVoyages } from './voyage-access.js';
import { toTradeString, tradeStringSelect } from './trade-string.read-model.js';

/** Trade-string use cases. Read-only for now: contracts are recorded by the seed. */
@Injectable()
export class TradeStringService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The voyage's trade string as topology (ADR 0010), or null both when the voyage does not
   * exist and when the principal's organization does not participate in it: one query, with
   * the access predicate inside it, so the two cases are indistinguishable.
   */
  async findForVoyage(principal: Principal, voyageId: string): Promise<TradeString | null> {
    const voyage = await this.prisma.voyage.findFirst({
      where: { AND: [{ id: voyageId }, accessibleVoyages(principal)] },
      select: tradeStringSelect,
    });
    return voyage ? toTradeString(voyage) : null;
  }
}
