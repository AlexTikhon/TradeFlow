import type { Request } from 'express';

/**
 * The verified identity behind a request. `AuthGuard` resolves it from the session cookie, and
 * the organization comes from the user's database row, never from anything the client sends.
 */
export interface Principal {
  sessionId: string;
  userId: string;
  organizationId: string;
}

export interface AuthenticatedRequest extends Request {
  principal?: Principal;
}
