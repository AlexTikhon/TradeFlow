import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import {
  identityKey,
  PROTECTED_QUERY_ROOT,
  type ProtectedScope,
  sameIdentity,
  useIdentity,
} from '../../../shared/auth/identity';
import {
  currentSessionEpoch,
  isCurrentSession,
  subscribeToSessionTransitions,
} from '../../auth/session';
import { canStreamVoyageEvents, connectToVoyageEvents } from '../api/voyage-events.api';
import { voyageQueries } from '../api/voyage.queries';

/** How often the notices and timeline are read again while no stream is live. */
export const FALLBACK_POLL_INTERVAL_MS = 30_000;

/** Waits before connecting again after the browser gave up on a stream; the last one repeats. */
export const RECONNECT_DELAYS_MS = [5_000, 15_000, 60_000] as const;

export interface VoyageLiveUpdates {
  /** A stream is connected and has said READY: changes arrive as they happen. */
  live: boolean;
  /**
   * The `refetchInterval` for the queries the stream keeps fresh: none while it is live, and
   * explicit polling while it is not (still connecting, reconnecting, or unavailable).
   */
  refetchInterval: number | false;
}

/**
 * Keeps the voyage's notices and timeline fresh while the page shows them, for the identity it
 * renders under. Connects to the voyage's event stream (once `enabled`, i.e. the voyage has
 * loaded) and, on each signal, reads exactly those two queries of the current scope again, with
 * requests sent after the signal (a read already on its way is cancelled, not waited for).
 *
 * - Reconciliation: every connection starts with READY, and READY reads both again, so whatever
 *   changed while disconnected (the stream has no replay) is caught up through REST.
 * - Tied to the session epoch it started in: the first transition that ends that epoch closes
 *   the connection, and any callback arriving afterwards is ignored. That covers signing out
 *   and back in as the same user, and session checks going to someone else and back, where the
 *   identity alone would look unchanged. The auth boundary remounts the page for the new
 *   session, which connects anew.
 * - Fallback: while not live, the caller polls with `refetchInterval` (TanStack Query skips it
 *   while the tab is hidden). If the browser gives up on the stream (a refused or failed
 *   connection), it is opened again after a growing delay.
 * - Bounded: one connection, at most one reconnect timer, and at most one refresh running with
 *   one more queued, however many signals arrive. Everything is released on unmount.
 */
export function useVoyageLiveUpdates(voyageId: string, enabled: boolean): VoyageLiveUpdates {
  const queryClient = useQueryClient();
  const identity = useIdentity();
  const [live, setLive] = useState(false);

  useEffect(() => {
    if (!enabled || !canStreamVoyageEvents()) return;
    const epoch = currentSessionEpoch(queryClient);
    // Rendered for an identity that is being replaced: the next session's page connects.
    if (!sameIdentity(epoch.identity, identity)) return;

    const scope: ProtectedScope = [PROTECTED_QUERY_ROOT, identityKey(identity)];
    const queryKeys = [
      voyageQueries.notices(scope, voyageId).queryKey,
      voyageQueries.timeline(scope, voyageId).queryKey,
    ];
    let stopped = false;
    const isCurrent = () => !stopped && isCurrentSession(queryClient, epoch);

    let refreshing = false;
    let refreshAgain = false;
    const refresh = () => {
      if (!isCurrent()) return;
      if (refreshing) {
        refreshAgain = true;
        return;
      }
      refreshing = true;
      void Promise.allSettled(
        queryKeys.map(async (queryKey) => {
          // A read already on its way was sent before this message, so its answer may predate
          // the change. Invalidating alone would wait for it when the query has no data yet
          // (the first load): cancel it, so the refresh always sends a read of its own.
          await queryClient.cancelQueries({ queryKey, exact: true });
          await queryClient.invalidateQueries({ queryKey, exact: true });
        }),
      ).finally(() => {
        refreshing = false;
        if (refreshAgain) {
          refreshAgain = false;
          refresh();
        }
      });
    };

    let connection: ReturnType<typeof connectToVoyageEvents> | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const connect = () => {
      connection = connectToVoyageEvents(voyageId, {
        onMessage: (message) => {
          if (!isCurrent()) return;
          if (message.type === 'READY') {
            failures = 0;
            setLive(true);
          }
          refresh();
        },
        onDisconnect: (retrying) => {
          if (!isCurrent()) return;
          setLive(false);
          if (retrying) return;
          connection?.close();
          const delay =
            RECONNECT_DELAYS_MS[Math.min(failures, RECONNECT_DELAYS_MS.length - 1)] ?? 60_000;
          failures += 1;
          clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(() => {
            if (isCurrent()) connect();
          }, delay);
        },
      });
    };

    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearTimeout(reconnectTimer);
      connection?.close();
      setLive(false);
    };
    const unsubscribe = subscribeToSessionTransitions(queryClient, () => {
      if (!isCurrentSession(queryClient, epoch)) stop();
    });
    connect();
    return () => {
      unsubscribe();
      stop();
    };
  }, [queryClient, identity, voyageId, enabled]);

  return { live, refetchInterval: live ? false : FALLBACK_POLL_INTERVAL_MS };
}
