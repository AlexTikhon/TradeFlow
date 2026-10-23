import { queryOptions } from '@tanstack/react-query';
import type { ProtectedScope } from '../../../shared/auth/identity';
import { actionQueueKey } from '../../../shared/cache/action-queue';
import { type ActionItemFilters, fetchActionItems } from './action-items.api';

/** How often the queue on screen reads its first page again, while visible and online. */
export const QUEUE_REFRESH_INTERVAL_MS = 30_000;

/**
 * Query keys for the Action Center. The queue is the signed-in organization's, so every key
 * starts with the identity's scope (`useProtectedScope()`), and each set of filters has keys of
 * its own: changing them never shows another filter's items, and starts from the first page.
 *
 * Pages are positions in the queue, not a snapshot of it (ADR 0017), so nothing is kept once
 * nothing shows it (`gcTime: 0`): coming back to the queue, or to a filter, starts again from the
 * first page. Every request carries the query's abort signal, so an identity change cancels a
 * page still on its way along with the rest of that identity's data.
 */
export const actionItemQueries = {
  all: (scope: ProtectedScope) => [...scope, 'action-items'] as const,
  /**
   * The queue's first page, under the key commands invalidate (`actionQueueKey`). It is the only
   * page ever read again: every 30 seconds while the page is visible and online (polling pauses
   * otherwise, and a read waits for the connection), when the page becomes visible or the
   * connection returns, after a command succeeds, and on Refresh. A trigger that arrives while a
   * read is on its way shares it; only a command's invalidation replaces it. A failed read keeps
   * the page it had, with the error beside it.
   */
  list: (scope: ProtectedScope, filters: ActionItemFilters) =>
    queryOptions({
      queryKey: [...actionQueueKey(scope), filters] as const,
      queryFn: ({ signal }) => fetchActionItems(filters, undefined, signal),
      gcTime: 0,
      // Every read is a page of its own, even with the same items: later pages restart from it.
      structuralSharing: false,
      refetchInterval: QUEUE_REFRESH_INTERVAL_MS,
      refetchOnWindowFocus: 'always',
      refetchOnReconnect: 'always',
    }),
  /**
   * A later page: the one after `cursor`, sent unchanged with the same filters. `walk` numbers the
   * walk from one first page, so a walk never reuses another's pages or cursors. Never read again
   * on its own: a refresh of the first page ends its walk instead.
   */
  page: (scope: ProtectedScope, filters: ActionItemFilters, walk: number, cursor: string) =>
    queryOptions({
      queryKey: [...actionItemQueries.all(scope), 'page', filters, walk, cursor] as const,
      queryFn: ({ signal }) => fetchActionItems(filters, cursor, signal),
      gcTime: 0,
      staleTime: Infinity,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    }),
};
