import { infiniteQueryOptions } from '@tanstack/react-query';
import type { ProtectedScope } from '../../../shared/auth/identity';
import { type ActionItemFilters, fetchActionItems } from './action-items.api';

/**
 * Query keys for the Action Center. The queue is the signed-in organization's, so every key
 * starts with the identity's scope (`useProtectedScope()`), and each set of filters has a key of
 * its own: changing them never shows another filter's items, and starts from the first page.
 */
export const actionItemQueries = {
  all: (scope: ProtectedScope) => [...scope, 'action-items'] as const,
  lists: (scope: ProtectedScope) => [...actionItemQueries.all(scope), 'list'] as const,
  /**
   * The queue, a page per "Load more". Every page request carries the query's abort signal, so an
   * identity change cancels a page still on its way along with the rest of that identity's data.
   *
   * Pages are positions in the queue, not a snapshot of it (ADR 0017), so a walk through them is
   * not kept once nothing shows it (`gcTime: 0`): coming back to the queue, or to a filter, starts
   * again from the first page instead of resuming a walk made earlier. Nothing refreshes it on
   * its own, not even focusing the window; the page's Refresh does, from the first page.
   */
  list: (scope: ProtectedScope, filters: ActionItemFilters) =>
    infiniteQueryOptions({
      queryKey: [...actionItemQueries.lists(scope), filters] as const,
      queryFn: ({ pageParam, signal }) => fetchActionItems(filters, pageParam, signal),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
      gcTime: 0,
      refetchOnWindowFocus: false,
    }),
};
