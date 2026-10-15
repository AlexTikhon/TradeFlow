import { Injectable } from '@nestjs/common';
import type { ListVoyagesQuery, VoyageDetail, VoyageListResponse } from '@tradeflow/contracts';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import type { Principal } from '../auth/principal.js';
import { accessibleVoyages } from './voyage-access.js';
import {
  toVoyageDetail,
  toVoyageSummary,
  voyageDetailSelect,
  voyageSummarySelect,
} from './voyage.read-model.js';

/** Voyage queries. Each takes the acting principal, so none can run unscoped. */
@Injectable()
export class VoyagesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(principal: Principal, query: ListVoyagesQuery): Promise<VoyageListResponse> {
    const rows = await this.prisma.voyage.findMany({
      where: {
        AND: [accessibleVoyages(principal), query.status ? { status: query.status } : {}],
      },
      select: voyageSummarySelect,
      // Most recent and upcoming laycans first; id breaks ties so ordering is deterministic.
      orderBy: [{ laycanStart: 'desc' }, { id: 'asc' }],
    });
    return { items: rows.map(toVoyageSummary) };
  }

  /**
   * Returns null both when the voyage does not exist and when the principal's organization does
   * not participate in it: the two cases are indistinguishable by design.
   */
  async findById(principal: Principal, id: string): Promise<VoyageDetail | null> {
    const row = await this.prisma.voyage.findFirst({
      where: { AND: [{ id }, accessibleVoyages(principal)] },
      select: voyageDetailSelect,
    });
    return row ? toVoyageDetail(row) : null;
  }
}
