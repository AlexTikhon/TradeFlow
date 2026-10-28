import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { CurrentUser, SignInRequest } from '@tradeflow/contracts';
import { TooManyRequestsException } from '../../common/http/too-many-requests.exception.js';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { hashPassword, verifyPassword } from './password.js';
import type { Principal } from './principal.js';
import {
  generateSessionToken,
  hashSessionToken,
  isWellFormedSessionToken,
} from './session-token.js';
import { SIGN_IN_BUSY_RETRY_AFTER_MS, SignInAdmission } from './sign-in-admission.js';

export interface SignInResult {
  /** The raw token. It goes into the cookie and is never stored or logged. */
  token: string;
  expiresAt: Date;
  currentUser: CurrentUser;
}

/** Sign-in, session validation and sign-out (ADR 0007). */
@Injectable()
export class AuthService {
  private dummyHash: Promise<string> | undefined;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly admission: SignInAdmission,
  ) {}

  /**
   * Verifies credentials and opens a new session. Returns null for every kind of failure
   * (unknown email, wrong password, user without a password) so callers cannot tell them apart.
   *
   * Holds one of a few sign-in slots from before the credential lookup until it returns or
   * throws (ADR 0018), so password hashing cannot pile up; with every slot taken it refuses at
   * once, touching nothing.
   */
  async signIn(
    credentials: SignInRequest,
    previousToken: string | undefined,
  ): Promise<SignInResult | null> {
    const leave = this.admission.enter();
    if (!leave) {
      throw new TooManyRequestsException(
        'Too many sign-ins are in progress. Try again shortly.',
        SIGN_IN_BUSY_RETRY_AFTER_MS,
      );
    }
    try {
      return await this.verifyAndOpenSession(credentials, previousToken);
    } finally {
      leave();
    }
  }

  private async verifyAndOpenSession(
    { email, password }: SignInRequest,
    previousToken: string | undefined,
  ): Promise<SignInResult | null> {
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, passwordHash: true },
    });
    // Always verify against some hash, so response time does not reveal whether the email exists.
    const passwordMatches = await verifyPassword(
      password,
      user?.passwordHash ?? (await this.getDummyHash()),
    );
    if (!user?.passwordHash || !passwordMatches) {
      return null;
    }

    const token = generateSessionToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.config.session.ttlMs);
    await this.prisma.$transaction([
      // A new token on every sign-in prevents session fixation; any session the browser
      // presented is ended rather than left valid alongside the new one.
      ...(previousToken !== undefined && isWellFormedSessionToken(previousToken)
        ? [this.revokeQuery(previousToken, now)]
        : []),
      // Housekeeping until background jobs exist: this user's dead sessions serve no purpose.
      this.prisma.session.deleteMany({
        where: { userId: user.id, OR: [{ expiresAt: { lte: now } }, { revokedAt: { not: null } }] },
      }),
      this.prisma.session.create({
        data: { userId: user.id, tokenHash: hashSessionToken(token), createdAt: now, expiresAt },
      }),
    ]);

    const currentUser = await this.getCurrentUser(user.id);
    if (!currentUser) {
      throw new Error(`User ${user.id} disappeared during sign-in`);
    }
    return { token, expiresAt, currentUser };
  }

  /**
   * Resolves a session token to the acting user, their organization and their role. Expiry and
   * revocation are checked in the query itself, and organization and role are read from the user
   * row on every request, so a change of membership or role takes effect immediately.
   */
  async authenticate(token: string): Promise<Principal | null> {
    if (!isWellFormedSessionToken(token)) {
      return null;
    }
    const session = await this.prisma.session.findUnique({
      where: { tokenHash: hashSessionToken(token), revokedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true, user: { select: { id: true, organizationId: true, role: true } } },
    });
    if (!session) {
      return null;
    }
    return {
      sessionId: session.id,
      userId: session.user.id,
      organizationId: session.user.organizationId,
      role: session.user.role,
    };
  }

  /** Revokes the session behind a token. Unknown or already-ended sessions are a no-op. */
  async signOut(token: string): Promise<void> {
    if (isWellFormedSessionToken(token)) {
      await this.revokeQuery(token, new Date());
    }
  }

  async getCurrentUser(userId: string): Promise<CurrentUser | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        organization: { select: { id: true, name: true, countryCode: true } },
      },
    });
    if (!user) {
      return null;
    }
    const { organization, ...profile } = user;
    return { user: profile, organization };
  }

  private revokeQuery(token: string, at: Date) {
    return this.prisma.session.updateMany({
      where: { tokenHash: hashSessionToken(token), revokedAt: null },
      data: { revokedAt: at },
    });
  }

  private getDummyHash(): Promise<string> {
    this.dummyHash ??= hashPassword(randomUUID());
    return this.dummyHash;
  }
}
