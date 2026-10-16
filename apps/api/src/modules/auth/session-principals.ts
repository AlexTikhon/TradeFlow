import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import type { Principal } from './principal.js';

/**
 * The principal of a session, read again. `AuthGuard` resolves the principal when a request
 * arrives; a command that runs long after that (an upload streams for seconds) asks again before
 * it commits, so a session that ended, or a user whose role or organization changed meanwhile,
 * acts as it is now, not as it was (ADR 0007, ADR 0008).
 */
@Injectable()
export class SessionPrincipals {
  constructor(private readonly prisma: PrismaService) {}

  /** The session's principal as of now, or null if the session expired or was revoked. */
  async refresh(
    principal: Principal,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<Principal | null> {
    const session = await db.session.findFirst({
      where: { id: principal.sessionId, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true, user: { select: { id: true, organizationId: true, role: true } } },
    });
    return (
      session && {
        sessionId: session.id,
        userId: session.user.id,
        organizationId: session.user.organizationId,
        role: session.user.role,
      }
    );
  }
}
