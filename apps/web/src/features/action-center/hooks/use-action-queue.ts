import { onlineManager, useQueries, useQuery } from '@tanstack/react-query';
import type { ActionItem, ActionItemPage } from '@tradeflow/contracts';
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ProtectedScope } from '../../../shared/auth/identity';
import type { ActionItemFilters } from '../api/action-items.api';
import { actionItemQueries } from '../api/action-items.queries';

/** The later pages asked for after one first page, by the cursors that lead to them. */
interface Walk {
  /** The first page it continues. A refresh replaces that page, and so ends the walk. */
  from: ActionItemPage | undefined;
  /** Numbers walks, so that each has page keys of its own. */
  number: number;
  cursors: string[];
}

const NO_WALK: Walk = { from: undefined, number: 0, cursors: [] };

export interface ActionQueue {
  /** The actions loaded so far, in the API's order; undefined until a first page has loaded. */
  items: ActionItem[] | undefined;
  /** When the API read the first page shown: the last successful refresh. */
  generatedAt: string | undefined;
  /** Why no first page could be loaded, while there is none to show. */
  loadError: Error | null;
  /** Why the latest refresh failed, while the actions shown are from an earlier one. */
  refreshError: Error | null;
  /** The first page is being read again. */
  refreshing: boolean;
  /** Whether the browser is online; offline, nothing is read until the connection returns. */
  online: boolean;
  /** Reads the first page again; the actions shown stay until it answers. */
  refresh: () => void;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  /** Why the page after the last one shown failed; it is offered again with `retryNextPage`. */
  nextPageError: Error | null;
  fetchNextPage: () => void;
  retryNextPage: () => void;
}

const subscribeToOnline = (listener: () => void) => onlineManager.subscribe(listener);
const isOnline = () => onlineManager.isOnline();

/**
 * The organization's queue for `filters`: a first page that is kept fresh, and the later pages
 * the user asked for after it, a page per "Load more" (ADR 0017).
 *
 * Every refresh reads only the first page (`actionItemQueries.list`). Once it answers, the walk
 * through later pages that followed the previous first page is over: its pages are no longer
 * shown, and a page of it still on its way is cancelled when nothing shows it any more, so it can
 * never be added to the restarted queue. "Load more" then continues from the new first page's
 * cursor. A failed refresh changes nothing that is shown; it is reported beside it.
 *
 * Besides what the first page's options refetch on (an interval while visible and online, the
 * page becoming visible, the connection returning, a command's invalidation), the window regaining
 * focus reads it again; that listener, the interval and any read on its way end with the
 * component, which the auth boundary replaces whenever the session changes.
 */
export function useActionQueue(scope: ProtectedScope, filters: ActionItemFilters): ActionQueue {
  const first = useQuery(actionItemQueries.list(scope, filters));
  const [walk, setWalk] = useState<Walk>(NO_WALK);
  const online = useSyncExternalStore(subscribeToOnline, isOnline);

  const firstPage = first.data;
  const cursors = firstPage !== undefined && walk.from === firstPage ? walk.cursors : [];
  const later = useQueries({
    queries: cursors.map((cursor) => actionItemQueries.page(scope, filters, walk.number, cursor)),
  });

  const { refetch } = first;
  useEffect(() => {
    // Shares a read already on its way, like every trigger but a command's invalidation.
    const onFocus = () => void refetch({ cancelRefetch: false });
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
    };
  }, [refetch]);

  // Pages are asked for one at a time, so only the last one can still be missing.
  const pages = firstPage && [firstPage, ...later.flatMap(({ data }) => (data ? [data] : []))];
  const last = later.at(-1);
  const pendingPage = last !== undefined && last.data === undefined ? last : undefined;
  const nextCursor = pages?.at(-1)?.nextCursor ?? null;

  return {
    items: pages?.flatMap((page) => page.items),
    generatedAt: firstPage?.generatedAt,
    loadError: firstPage ? null : first.error,
    refreshError: firstPage ? first.error : null,
    refreshing: first.isFetching,
    online,
    refresh: () => {
      void refetch();
    },
    hasNextPage: nextCursor !== null,
    // Asked for and not failed: on its way, or waiting for the connection.
    isFetchingNextPage: pendingPage !== undefined && pendingPage.error === null,
    nextPageError: pendingPage?.error ?? null,
    fetchNextPage: () => {
      if (firstPage === undefined || nextCursor === null || pendingPage) return;
      setWalk((current) =>
        current.from === firstPage
          ? { ...current, cursors: [...current.cursors, nextCursor] }
          : { from: firstPage, number: current.number + 1, cursors: [nextCursor] },
      );
    },
    retryNextPage: () => {
      void pendingPage?.refetch();
    },
  };
}
