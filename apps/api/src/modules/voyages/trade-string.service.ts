import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  PreconditionFailedException,
  UnauthorizedException,
} from '@nestjs/common';
import type {
  ConfigureTradeStringRequest,
  ProblemFieldError,
  TradeString,
} from '@tradeflow/contracts';
import { RequestValidationException } from '../../common/http/request-validation.exception.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { AuditTrail } from '../audit/audit-trail.js';
import type { Principal } from '../auth/principal.js';
import { SessionPrincipals } from '../auth/session-principals.js';
import { requireOperator } from '../auth/user-permissions.js';
import { accessibleVoyages } from './voyage-access.js';
import { validateTradeString } from './trade-string.js';
import { toTradeString, tradeStringSelect } from './trade-string.read-model.js';
import {
  candidateTradeString,
  failedSetupPrecondition,
  type SetupPreconditions,
  tradeStringFieldErrors,
} from './trade-string-setup.js';

/** The same answer as GET /voyages/:voyageId: existence is not disclosed. */
const VOYAGE_NOT_FOUND = 'Voyage was not found.';

export const TRADE_STRING_ALREADY_CONFIGURED =
  "This voyage's trade string is already set up. It cannot be set up again or changed here.";

/** Trade-string use cases: reading the chain, and setting it up once on a new voyage. */
@Injectable()
export class TradeStringService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionPrincipals,
    private readonly audit: AuditTrail,
  ) {}

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

  /**
   * Records the whole chain of a new voyage, with its participants and one audit event, in one
   * transaction (ADR 0016). Only an operator of the voyage's exporter may, only while the voyage
   * is PLANNED, has no contracts and no participant but its exporter. Every check after the
   * role is made under the voyage's lock, in the order the ADR fixes: who is asking (as the
   * session is now), then the voyage's state, then the request's preconditions, then the chain.
   */
  async configure(
    principal: Principal,
    voyageId: string,
    request: ConfigureTradeStringRequest,
    preconditions: SetupPreconditions,
  ): Promise<TradeString> {
    requireOperator(principal, 'set up trade strings');

    return this.prisma.$transaction(async (tx) => {
      const visible = await tx.voyage.findFirst({
        where: { AND: [{ id: voyageId }, accessibleVoyages(principal)] },
        select: { id: true },
      });
      if (!visible || !(await lockVoyage(tx, voyageId))) {
        throw new NotFoundException(VOYAGE_NOT_FOUND);
      }

      // The lock may have waited behind another setup: act as the session is now. The lock
      // serializes setups of this voyage only; it does not hold back sign-outs or role changes.
      const actor = await this.sessions.refresh(principal, tx);
      if (!actor) {
        throw new UnauthorizedException(
          'Your session ended before the trade string was set up. Sign in and try again.',
        );
      }
      requireOperator(actor, 'set up trade strings');
      const participations = await tx.voyageParticipant.findMany({
        where: { voyageId, organizationId: actor.organizationId },
        select: { id: true, organizationId: true, role: true },
      });
      const exporter = participations.find(({ role }) => role === 'EXPORTER');
      if (participations.length === 0) {
        throw new NotFoundException(VOYAGE_NOT_FOUND);
      }
      if (!exporter) {
        throw new ForbiddenException("Only the voyage's exporter may set up its trade string.");
      }

      // A configured voyage always gets the same answer, before the gates its own
      // configuration would trip (the participants it added).
      const state = await tx.voyage.findUniqueOrThrow({
        where: { id: voyageId },
        select: { status: true, _count: { select: { tradeContracts: true, participants: true } } },
      });
      if (state._count.tradeContracts > 0) {
        throw new ConflictException(TRADE_STRING_ALREADY_CONFIGURED);
      }
      if (state.status !== 'PLANNED') {
        throw new ConflictException(
          `Only a PLANNED voyage can have its trade string set up; this one is ${state.status}.`,
        );
      }
      if (state._count.participants > 1) {
        throw new ConflictException(
          'This voyage already has participants other than its exporter, so its trade string ' +
            'cannot be set up here.',
        );
      }

      const failed = failedSetupPrecondition(preconditions);
      if (failed) {
        throw new PreconditionFailedException(failed);
      }

      const organizationIds = request.parties.map(({ organizationId }) => organizationId);
      const unknown = await unknownOrganizations(tx, organizationIds);
      const errors: ProblemFieldError[] = [];
      organizationIds.forEach((organizationId, index) => {
        if (index === 0 && organizationId !== exporter.organizationId) {
          errors.push({
            path: 'body.parties.0.organizationId',
            message: "The trade string must start with the voyage's exporter",
          });
        } else if (unknown.has(organizationId)) {
          errors.push({
            path: `body.parties.${index}.organizationId`,
            message: 'No organization has this id',
          });
        }
      });
      if (errors.length > 0) {
        throw new RequestValidationException(errors);
      }
      const candidate = candidateTradeString(
        {
          participantId: exporter.id,
          organizationId: exporter.organizationId,
          role: exporter.role,
        },
        organizationIds.slice(1),
      );
      const violations = validateTradeString(candidate.contracts);
      if (violations.length > 0) {
        throw new RequestValidationException(tradeStringFieldErrors(violations));
      }

      const created = await tx.voyageParticipant.createManyAndReturn({
        data: candidate.parties
          .slice(1)
          .map(({ organizationId, role }) => ({ voyageId, organizationId, role })),
        select: { id: true, organizationId: true },
      });
      const participantIds = new Map([
        [exporter.organizationId, exporter.id],
        ...created.map(({ organizationId, id }) => [organizationId, id] as const),
      ]);
      const participantOf = (organizationId: string) => {
        const id = participantIds.get(organizationId);
        if (!id) throw new Error(`No participant was created for ${organizationId}`);
        return id;
      };
      const contracts = await tx.tradeContract.createManyAndReturn({
        data: candidate.contracts.map(({ position, seller, buyer }) => ({
          voyageId,
          position,
          sellerParticipantId: participantOf(seller.organizationId),
          buyerParticipantId: participantOf(buyer.organizationId),
        })),
        select: { id: true, position: true },
      });

      // Read back through the read model, which validates the stored chain once more.
      const tradeString = toTradeString(
        await tx.voyage.findUniqueOrThrow({ where: { id: voyageId }, select: tradeStringSelect }),
      );
      const contractIds = new Map(contracts.map(({ position, id }) => [position, id]));
      const contractAt = (position: number) => {
        const id = contractIds.get(position);
        if (!id) throw new Error(`No contract was created at position ${position}`);
        return id;
      };
      await this.audit.record(tx, {
        action: 'VOYAGE_TRADE_STRING_CONFIGURED',
        actor,
        voyageId,
        payload: {
          parties: candidate.parties.map(({ organizationId, role }) => ({
            organizationId,
            role,
            participantId: participantOf(organizationId),
          })),
          contracts: tradeString.edges.map(
            ({ position, sellerOrganizationId, buyerOrganizationId }) => ({
              contractId: contractAt(position),
              position,
              sellerOrganizationId,
              buyerOrganizationId,
            }),
          ),
        },
      });
      return tradeString;
    });
  }
}

/**
 * Locks the voyage row until the transaction ends, or returns false if there is none. FOR NO KEY
 * UPDATE conflicts with itself, so competing setups queue here, but not with the key-share
 * locks foreign keys take, so writes under the voyage's contracts go on. Under READ COMMITTED,
 * every statement after it sees what a setup that held the lock before committed.
 */
async function lockVoyage(tx: Prisma.TransactionClient, voyageId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM voyages WHERE id = ${voyageId}::uuid FOR NO KEY UPDATE`;
  return rows.length > 0;
}

/** The ids among `ids` that name no organization. */
async function unknownOrganizations(
  tx: Prisma.TransactionClient,
  ids: readonly string[],
): Promise<Set<string>> {
  const known = await tx.organization.findMany({
    where: { id: { in: [...ids] } },
    select: { id: true },
  });
  const found = new Set(known.map(({ id }) => id));
  return new Set(ids.filter((id) => !found.has(id)));
}
