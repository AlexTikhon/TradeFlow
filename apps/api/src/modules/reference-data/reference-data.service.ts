import { Injectable } from '@nestjs/common';
import type {
  CommodityListResponse,
  PortListResponse,
  VesselListResponse,
} from '@tradeflow/contracts';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';

/** Ids of reference data that a command refers to, keyed by the request field naming them. */
export interface ReferenceIds {
  vesselId: string;
  commodityId: string;
  loadPortId: string;
  dischargePortId: string;
}

/**
 * Vessels, commodities and ports: reference data shared by every organization. The sets are
 * small and curated, so lists are returned whole, ordered by name.
 */
@Injectable()
export class ReferenceDataService {
  constructor(private readonly prisma: PrismaService) {}

  async listVessels(): Promise<VesselListResponse> {
    const items = await this.prisma.vessel.findMany({
      select: { id: true, name: true, imoNumber: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    return { items };
  }

  async listCommodities(): Promise<CommodityListResponse> {
    const items = await this.prisma.commodity.findMany({
      select: { id: true, code: true, name: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    return { items };
  }

  async listPorts(): Promise<PortListResponse> {
    const items = await this.prisma.port.findMany({
      select: { id: true, unLocode: true, name: true, countryCode: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    return { items };
  }

  /**
   * The request fields whose id names no existing row. Reference data is never deleted while a
   * voyage uses it (foreign keys restrict), so this check plus the foreign keys is sufficient.
   */
  async unknownReferences(ids: ReferenceIds): Promise<(keyof ReferenceIds)[]> {
    const portIds = [ids.loadPortId, ids.dischargePortId];
    const [vessel, commodity, ports] = await Promise.all([
      this.prisma.vessel.findUnique({ where: { id: ids.vesselId }, select: { id: true } }),
      this.prisma.commodity.findUnique({ where: { id: ids.commodityId }, select: { id: true } }),
      this.prisma.port.findMany({ where: { id: { in: portIds } }, select: { id: true } }),
    ]);
    const knownPorts = new Set(ports.map((port) => port.id));
    return [
      ...(vessel ? [] : ['vesselId' as const]),
      ...(commodity ? [] : ['commodityId' as const]),
      ...(knownPorts.has(ids.loadPortId) ? [] : ['loadPortId' as const]),
      ...(knownPorts.has(ids.dischargePortId) ? [] : ['dischargePortId' as const]),
    ];
  }
}
