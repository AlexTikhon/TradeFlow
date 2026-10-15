import { Injectable } from '@nestjs/common';
import type { AuditAction, Prisma } from '../../generated/prisma/client.js';
import type { Principal } from '../auth/principal.js';

export interface AuditEventInput {
  action: AuditAction;
  /** Who acted: always the authenticated principal, never anything taken from the request. */
  actor: Principal;
  voyageId: string;
  payload: Prisma.InputJsonObject;
}

/**
 * Records business actions in `audit_events` (ADR 0009). It only ever inserts, and only through
 * the caller's transaction: the event commits with the action or neither happens. The time is
 * stamped by the server as the event is written; no caller can supply it.
 */
@Injectable()
export class AuditTrail {
  async record(tx: Prisma.TransactionClient, event: AuditEventInput): Promise<void> {
    await tx.auditEvent.create({
      data: {
        action: event.action,
        actorUserId: event.actor.userId,
        actorOrganizationId: event.actor.organizationId,
        voyageId: event.voyageId,
        payload: event.payload,
      },
      select: { id: true },
    });
  }
}
