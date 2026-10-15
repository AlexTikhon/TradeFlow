import type { CurrentUser } from '@tradeflow/contracts';
import { createContext, useContext } from 'react';

/*
 * Identity scoping for client-side server state.
 *
 * Every query whose data depends on who is signed in lives under
 * `['protected', <identity key>, ...]`. A component can only build keys for the identity it is
 * rendered under, so data cached for one identity can never be read while another is active,
 * even for one frame, whatever the timing of cache cleanup. Cleanup (cancelling in-flight
 * requests and dropping the data) happens on every identity change as well; see
 * `features/auth/session.ts`.
 */

export const PROTECTED_QUERY_ROOT = 'protected';

export type ProtectedScope = readonly [typeof PROTECTED_QUERY_ROOT, string];

/** "Who is acting": the user and the organization they act for. */
export const identityKey = (identity: CurrentUser): string =>
  `${identity.user.id}:${identity.organization.id}`;

export const sameIdentity = (
  a: CurrentUser | null | undefined,
  b: CurrentUser | null | undefined,
): boolean => (a && b ? identityKey(a) === identityKey(b) : a === b);

/** Provided by the auth boundary around every protected route. */
export const IdentityContext = createContext<CurrentUser | null>(null);

export function useIdentity(): CurrentUser {
  const identity = useContext(IdentityContext);
  if (!identity) {
    throw new Error('useIdentity must be used inside a protected route');
  }
  return identity;
}

/** The query-key prefix for data belonging to the signed-in identity. */
export function useProtectedScope(): ProtectedScope {
  return [PROTECTED_QUERY_ROOT, identityKey(useIdentity())];
}
