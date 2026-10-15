import { Injectable } from '@nestjs/common';
import type { ListVoyagesQuery, VoyageDetail, VoyageListResponse } from '@tradeflow/contracts';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import {
  toVoyageDetail,
  toVoyageSummary,
  voyageDetailSelect,
  voyageSummarySelect,
} from './voyage.read-model.js';

@Injectable()
export class VoyagesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ListVoyagesQuery): Promise<VoyageListResponse> {
    const rows = await this.prisma.voyage.findMany({
      where: query.status ? { status: query.status } : {},
      select: voyageSummarySelect,
      // Most recent and upcoming laycans first; id breaks ties so ordering is deterministic.
      orderBy: [{ laycanStart: 'desc' }, { id: 'asc' }],
    });
    return { items: rows.map(toVoyageSummary) };
  }

  async findById(id: string): Promise<VoyageDetail | null> {
    const row = await this.prisma.voyage.findUnique({
      where: { id },
      select: voyageDetailSelect,
    });
    return row ? toVoyageDetail(row) : null;
  }
}
