import type { Request } from 'express';
import type { UserRole } from '../../generated/prisma/client.js';

/**
 * The verified identity behind a request. `AuthGuard` resolves it from the session cookie. The
 * organization and role come from the user's database row on every request, never from anything
 * the client sends, so a changed role applies to the very next request.
 */
export interface Principal {
  sessionId: string;
  userId: string;
  organizationId: string;
  role: UserRole;
}

export interface AuthenticatedRequest extends Request {
  principal?: Principal;
}
