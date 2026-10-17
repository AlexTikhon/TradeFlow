import { ConflictException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import type {
  CounterpartyContract,
  IssueNoticeRequest,
  Notice,
  NoticeListResponse,
} from '@tradeflow/contracts';
import { RequestValidationException } from '../../common/http/request-validation.exception.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { AuditTrail } from '../audit/audit-trail.js';
import type { Principal } from '../auth/principal.js';
import { requireOperator } from '../auth/user-permissions.js';
import { CounterpartyContracts } from '../voyages/counterparty-contracts.js';
import { type VoyageChange, VoyageEventBus } from '../voyages/voyage-event-bus.js';
import { deadlineViolations, isLate } from './notice-rules.js';
import { noticeOrder, type NoticeRow, noticeSelect, toNotice } from './notice.read-model.js';

/** A notice the principal may read, with its contract as the principal sees it. */
interface VisibleNotice {
  row: NoticeRow;
  contract: CounterpartyContract;
}

/**
 * Notice use cases (ADR 0011). Each takes the acting principal. Reads are scoped in the
 * database: notices are loaded only under contracts the voyages module resolved for the
 * principal's organization as a counterparty, so another participant's request finds nothing.
 * Commands check the user's role and the organization's side of the contract here, in the
 * service, and write the change and its audit event in one transaction. Once that transaction
 * has committed, and only then, they announce the change to open voyage streams.
 */
@Injectable()
export class NoticesService {
  private readonly logger = new Logger(NoticesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly contracts: CounterpartyContracts,
    private readonly audit: AuditTrail,
    private readonly events: VoyageEventBus,
  ) {}

  /**
   * The notices on the voyage that the principal's organization may read: those under its own
   * contracts. Null when the voyage does not exist or the organization does not participate in
   * it; empty for a participant that is a party to no contract.
   */
  async list(principal: Principal, voyageId: string): Promise<NoticeListResponse | null> {
    const contracts = await this.contracts.listForVoyage(principal, voyageId);
    if (!contracts) {
      return null;
    }
    const byId = new Map(contracts.map((contract) => [contract.id, contract]));
    const rows =
      contracts.length === 0
        ? []
        : await this.prisma.notice.findMany({
            where: { voyageId, tradeContractId: { in: [...byId.keys()] } },
            select: noticeSelect,
            orderBy: noticeOrder,
          });
    const now = new Date();
    return {
      items: rows.map((row) => toNotice(row, contractOf(byId, row), now)),
    };
  }

  /**
   * One notice, or null alike when it does not exist, belongs to another voyage, or is under a
   * contract the principal's organization is not a party to.
   */
  async findById(principal: Principal, voyageId: string, noticeId: string): Promise<Notice | null> {
    const visible = await this.findVisible(this.prisma, principal, voyageId, noticeId);
    return visible && toNotice(visible.row, visible.contract, new Date());
  }

  /**
   * Issues an ETA notice under one of the voyage's contracts. Only an operator of the contract's
   * seller may. Null when the contract cannot be found for the principal's organization (missing,
   * of another voyage, or someone else's): the same answer in each case. The issuer and the time
   * of issue come from the session and the server's clock.
   */
  async issue(
    principal: Principal,
    voyageId: string,
    request: IssueNoticeRequest,
  ): Promise<Notice | null> {
    requireOperator(principal, 'issue notices');

    const issued = await this.prisma.$transaction(async (tx) => {
      const contract = await this.contracts.findForVoyage(
        principal,
        voyageId,
        request.contractId,
        tx,
      );
      if (!contract) {
        return null;
      }
      if (contract.side !== 'SELLER') {
        throw new ForbiddenException('Only the seller under a contract may issue its notices.');
      }

      const issuedAt = new Date();
      const deadlines = {
        estimatedArrivalAt: new Date(request.estimatedArrivalAt),
        acknowledgementDueAt: new Date(request.acknowledgementDueAt),
      };
      const violations = deadlineViolations(deadlines, issuedAt);
      if (violations.length > 0) {
        throw new RequestValidationException(
          violations.map(({ field, message }) => ({ path: `body.${field}`, message })),
        );
      }

      const row = await tx.notice.create({
        data: {
          voyageId,
          tradeContractId: contract.id,
          type: 'ETA',
          status: 'ISSUED',
          ...deadlines,
          message: request.message ?? null,
          issuedByUserId: principal.userId,
          issuedByOrganizationId: principal.organizationId,
          issuedAt,
        },
        select: noticeSelect,
      });
      await this.audit.record(tx, {
        action: 'NOTICE_ISSUED',
        actor: principal,
        voyageId,
        payload: issuedFacts(row),
      });
      return { row, contract };
    });
    if (!issued) return null;
    this.announce({ type: 'NOTICE_ISSUED', voyageId, contractId: issued.contract.id });
    return toNotice(issued.row, issued.contract, new Date());
  }

  /**
   * Records that the buyer received the notice. Only an operator of the contract's buyer may,
   * and only once: the transition is a conditional update (`status = 'ISSUED'`), so of two
   * concurrent acknowledgements exactly one changes the row and records an event, and the other
   * gets 409. A late acknowledgement is accepted. Null when the notice is not visible to the
   * principal, as for `findById`.
   */
  async acknowledge(
    principal: Principal,
    voyageId: string,
    noticeId: string,
  ): Promise<Notice | null> {
    requireOperator(principal, 'acknowledge notices');

    const acknowledged = await this.prisma.$transaction(async (tx) => {
      const visible = await this.findVisible(tx, principal, voyageId, noticeId);
      if (!visible) {
        return null;
      }
      if (visible.contract.side !== 'BUYER') {
        throw new ForbiddenException(
          'Only the buyer under a contract may acknowledge its notices.',
        );
      }

      const acknowledgedAt = new Date();
      const { count } = await tx.notice.updateMany({
        where: { id: noticeId, status: 'ISSUED' },
        data: {
          status: 'ACKNOWLEDGED',
          acknowledgedByUserId: principal.userId,
          acknowledgedByOrganizationId: principal.organizationId,
          acknowledgedAt,
        },
      });
      if (count === 0) {
        throw new ConflictException('This notice has already been acknowledged.');
      }
      await this.audit.record(tx, {
        action: 'NOTICE_ACKNOWLEDGED',
        actor: principal,
        voyageId,
        payload: {
          noticeId,
          contractId: visible.contract.id,
          acknowledgedAt: acknowledgedAt.toISOString(),
          late: isLate(acknowledgedAt, visible.row.acknowledgementDueAt),
        },
      });
      const row = await tx.notice.findUniqueOrThrow({
        where: { id: noticeId },
        select: noticeSelect,
      });
      return { row, contract: visible.contract };
    });
    if (!acknowledged) return null;
    this.announce({
      type: 'NOTICE_ACKNOWLEDGED',
      voyageId,
      contractId: acknowledged.contract.id,
    });
    return toNotice(acknowledged.row, acknowledged.contract, new Date());
  }

  /**
   * Tells open voyage streams about a change that has committed. Called after the transaction,
   * never inside it: a change that rolled back, or an acknowledgement that lost its race (409),
   * is never announced. Best effort: the change stands whatever happens here, so a failure is
   * logged and the command still succeeds.
   */
  private announce(change: VoyageChange): void {
    try {
      this.events.publish(change);
    } catch (error) {
      this.logger.error(
        `Could not announce ${change.type} on voyage ${change.voyageId}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /** Loads a notice only under a contract resolved for the principal as a counterparty. */
  private async findVisible(
    db: Prisma.TransactionClient,
    principal: Principal,
    voyageId: string,
    noticeId: string,
  ): Promise<VisibleNotice | null> {
    const contracts = await this.contracts.listForVoyage(principal, voyageId, db);
    if (!contracts || contracts.length === 0) {
      return null;
    }
    const byId = new Map(contracts.map((contract) => [contract.id, contract]));
    const row = await db.notice.findFirst({
      where: { id: noticeId, voyageId, tradeContractId: { in: [...byId.keys()] } },
      select: noticeSelect,
    });
    return row && { row, contract: contractOf(byId, row) };
  }
}

function contractOf(byId: Map<string, CounterpartyContract>, row: NoticeRow) {
  const contract = byId.get(row.tradeContractId);
  if (!contract) {
    // The query filtered on exactly these contracts; anything else is a programming error.
    throw new Error(`Notice ${row.id} was loaded under a contract the reader cannot see`);
  }
  return contract;
}

/** What NOTICE_ISSUED records: the notice as issued, by id. */
function issuedFacts(row: NoticeRow) {
  return {
    noticeId: row.id,
    contractId: row.tradeContractId,
    type: row.type,
    estimatedArrivalAt: row.estimatedArrivalAt.toISOString(),
    acknowledgementDueAt: row.acknowledgementDueAt.toISOString(),
    message: row.message,
    issuedAt: row.issuedAt.toISOString(),
  };
}
