import type { QueryClient } from '@tanstack/react-query';
import type { ProtectedScope } from '../auth/identity';

/*
 * The boundary between the commands that change what an organization owes (on a voyage's page)
 * and the Action Center that lists it (ADR 0017). Neither feature imports the other: commands
 * invalidate the queue through this key, and the Action Center keeps its first pages under it.
 */

/** Every first page of the queue, one per set of filters, for the identity of `scope`. */
export const actionQueueKey = (scope: ProtectedScope) =>
  [...scope, 'action-items', 'queue'] as const;

/**
 * A command succeeded, so the queue of `scope` may have changed. A queue on screen reads its
 * first page again at once (a read already on its way is replaced by one sent now, since its
 * answer may predate the command); any other filter is only marked stale, never fetched. Call it
 * only while the session the command was issued in is still current.
 */
export function invalidateActionQueue(
  queryClient: QueryClient,
  scope: ProtectedScope,
): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: actionQueueKey(scope), refetchType: 'active' });
}
