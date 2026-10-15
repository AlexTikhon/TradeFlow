import { Injectable } from '@nestjs/common';
import type {
  CreateVoyageRequest,
  ListVoyagesQuery,
  VoyageDetail,
  VoyageListResponse,
} from '@tradeflow/contracts';
import { RequestValidationException } from '../../common/http/request-validation.exception.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { AuditTrail } from '../audit/audit-trail.js';
import type { Principal } from '../auth/principal.js';
import { requireOperator } from '../auth/user-permissions.js';
import {
  type ReferenceIds,
  ReferenceDataService,
} from '../reference-data/reference-data.service.js';
import { accessibleVoyages } from './voyage-access.js';
import { takeNextVoyageReference } from './voyage-reference.js';
import {
  toVoyageDetail,
  toVoyageSummary,
  type VoyageDetailRow,
  voyageDetailSelect,
  voyageSummarySelect,
} from './voyage.read-model.js';

const UNKNOWN_REFERENCE: Record<keyof ReferenceIds, string> = {
  vesselId: 'No vessel has this id',
  commodityId: 'No commodity has this id',
  loadPortId: 'No port has this id',
  dischargePortId: 'No port has this id',
};

/** The voyage as created, by id: what the VOYAGE_CREATED audit event records. */
function creationFacts(voyage: VoyageDetailRow) {
  const detail = toVoyageDetail(voyage);
  return {
    reference: detail.reference,
    status: detail.status,
    vesselId: detail.vessel.id,
    commodityId: detail.commodity.id,
    quantity: detail.quantity,
    loadPortId: detail.loadPort.id,
    dischargePortId: detail.dischargePort.id,
    laycan: detail.laycan,
    participants: detail.participants.map(({ organization, role }) => ({
      organizationId: organization.id,
      role,
    })),
  };
}

/** Voyage use cases. Each takes the acting principal, so none can run unscoped. */
@Injectable()
export class VoyagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly referenceData: ReferenceDataService,
    private readonly audit: AuditTrail,
  ) {}

  /**
   * Creates a voyage on behalf of the principal's organization. Initial business rule: the
   * creating organization is the voyage's exporter, and every voyage starts PLANNED. The
   * reference, status, participant and audit actor all come from the server.
   *
   * The voyage, its participation and its VOYAGE_CREATED audit event are written in one
   * transaction: if any of them fails, none exists.
   */
  async create(principal: Principal, request: CreateVoyageRequest): Promise<VoyageDetail> {
    requireOperator(principal, 'create voyages');

    const unknown = await this.referenceData.unknownReferences(request);
    if (unknown.length > 0) {
      throw new RequestValidationException(
        unknown.map((field) => ({ path: `body.${field}`, message: UNKNOWN_REFERENCE[field] })),
      );
    }

    const voyage = await this.prisma.$transaction(async (tx) => {
      const created = await tx.voyage.create({
        data: {
          reference: await takeNextVoyageReference(tx),
          status: 'PLANNED',
          vesselId: request.vesselId,
          commodityId: request.commodityId,
          // The exact decimal string: validated to fit DECIMAL(14,3), so nothing is rounded.
          quantity: request.quantity.amount,
          quantityUnit: request.quantity.unit,
          loadPortId: request.loadPortId,
          dischargePortId: request.dischargePortId,
          laycanStart: new Date(request.laycan.start),
          laycanEnd: new Date(request.laycan.end),
          participants: {
            create: { organizationId: principal.organizationId, role: 'EXPORTER' },
          },
        },
        select: voyageDetailSelect,
      });
      await this.audit.record(tx, {
        action: 'VOYAGE_CREATED',
        actor: principal,
        voyageId: created.id,
        payload: creationFacts(created),
      });
      return created;
    });
    return toVoyageDetail(voyage);
  }

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
