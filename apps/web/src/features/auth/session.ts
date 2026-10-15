import { type Query, type QueryClient, queryOptions } from '@tanstack/react-query';

import type { CurrentUser } from '@tradeflow/contracts';
import { identityKey, PROTECTED_QUERY_ROOT, sameIdentity } from '../../shared/auth/identity';
import { fetchCurrentUser } from './api/auth.api';

/*
 * The session is server state like any other (ADR 0003): the server decides who is signed in,
 * and `GET /api/auth/me` is how the client asks. `null` means signed out.
 */

const SESSION_KEY = ['session'] as const;

export const sessionQuery = queryOptions({
  queryKey: SESSION_KEY,
  queryFn: async ({ signal, client }) => {
    const identity = await fetchCurrentUser(signal);
    // The cookie can change behind this tab's back (another tab signed in as someone else).
    // Drop the previous identity's data before the new identity is stored and rendered.
    if (!sameIdentity(client.getQueryData<CurrentUser | null>(SESSION_KEY), identity)) {
      await purgeProtectedData(client);
    }
    return identity;
  },
  // Re-check whenever the user returns to the tab: the session may have ended meanwhile.
  refetchOnWindowFocus: 'always',
});

const isProtected = (query: Query) => query.queryKey[0] === PROTECTED_QUERY_ROOT;

function belongsToCurrentIdentity(queryClient: QueryClient, query: Query): boolean {
  const current = queryClient.getQueryData<CurrentUser | null>(SESSION_KEY);
  return Boolean(current) && query.queryKey[1] === (current && identityKey(current));
}

/**
 * Aborts every in-flight protected request and drops all protected data nothing is displaying.
 * Queries still observed belong to components that are about to unmount; removing them now
 * would let their last render rebuild (and refetch) them. `dropAbandonedProtectedQueries`
 * removes them the moment they are no longer observed.
 */
export async function purgeProtectedData(queryClient: QueryClient): Promise<void> {
  await queryClient.cancelQueries({ queryKey: [PROTECTED_QUERY_ROOT] });
  queryClient.removeQueries({
    queryKey: [PROTECTED_QUERY_ROOT],
    predicate: (query) => query.getObserversCount() === 0,
  });
}

/**
 * Cache invariant: a protected query that does not belong to the current identity is removed
 * as soon as its last observer goes away. Returns an unsubscribe function.
 */
export function dropAbandonedProtectedQueries(queryClient: QueryClient): () => void {
  const cache = queryClient.getQueryCache();
  return cache.subscribe((event) => {
    if (event.type !== 'observerRemoved') return;
    const query = cache.get(event.query.queryHash);
    if (
      query &&
      isProtected(query) &&
      query.getObserversCount() === 0 &&
      !belongsToCurrentIdentity(queryClient, query)
    ) {
      void query.cancel();
      cache.remove(query);
    }
  });
}

/**
 * The only way the client changes who is signed in. If the identity actually changes, the
 * previous identity's requests are aborted and its data dropped *before* the new identity is
 * published to the UI.
 */
export async function switchIdentity(
  queryClient: QueryClient,
  next: CurrentUser | null,
): Promise<void> {
  if (!sameIdentity(queryClient.getQueryData(sessionQuery.queryKey), next)) {
    await purgeProtectedData(queryClient);
  }
  queryClient.setQueryData(sessionQuery.queryKey, next);
}
