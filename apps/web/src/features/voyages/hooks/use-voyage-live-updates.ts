import { useQueryClient } from '@tanstack/react-query';
import type { VoyageStreamMessage } from '@tradeflow/contracts';
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

/** How often the live resources are read again while no stream is live. */
export const FALLBACK_POLL_INTERVAL_MS = 30_000;

/** Waits before connecting again after the browser gave up on a stream; the last one repeats. */
export const RECONNECT_DELAYS_MS = [5_000, 15_000, 60_000] as const;

/** The voyage's queries the stream keeps fresh. */
type LiveResource = 'notices' | 'documentaryInstructions' | 'documents' | 'timeline';

/**
 * What each message makes the page read again. READY starts every (re)connection, after which
 * anything may have changed unseen, so it reads everything; a change reads what it touched, and
 * the timeline, where every change is recorded. Exhaustive: a new message type does not compile
 * until it says what it refreshes.
 */
const REFRESHED_BY: Record<VoyageStreamMessage['type'], readonly LiveResource[]> = {
  READY: ['notices', 'documentaryInstructions', 'documents', 'timeline'],
  NOTICE_ISSUED: ['notices', 'timeline'],
  NOTICE_ACKNOWLEDGED: ['notices', 'timeline'],
  DOCUMENTARY_INSTRUCTION_REVISED: ['documentaryInstructions', 'timeline'],
  DOCUMENTARY_INSTRUCTION_ACKNOWLEDGED: ['documentaryInstructions', 'timeline'],
  DOCUMENT_VERSION_UPLOADED: ['documents', 'timeline'],
  DOCUMENT_VERSION_REVIEWED: ['documents', 'timeline'],
};

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
 * Keeps the voyage's notices, documentary instructions, documents and timeline fresh while the
 * page shows them, for the identity it renders under. Connects to the voyage's event stream (once
 * `enabled`, i.e. the voyage has loaded) and, on each message, reads again exactly the queries
 * of the current scope it concerns (`REFRESHED_BY`), with requests sent after the message (a
 * read already on its way is cancelled, not waited for).
 *
 * - Reconciliation: every connection starts with READY, and READY reads all four again, so
 *   whatever changed while disconnected (the stream has no replay) is caught up through REST.
 * - Tied to the session epoch it started in: the first transition that ends that epoch closes
 *   the connection, and any callback arriving afterwards is ignored. That covers signing out
 *   and back in as the same user, and session checks going to someone else and back, where the
 *   identity alone would look unchanged. The auth boundary remounts the page for the new
 *   session, which connects anew.
 * - Fallback: while not live, the caller polls with `refetchInterval` (TanStack Query skips it
 *   while the tab is hidden). If the browser gives up on the stream (a refused or failed
 *   connection), it is opened again after a growing delay.
 * - Bounded: one connection, at most one reconnect timer, and at most one refresh running.
 *   Messages that arrive during a refresh add what they concern to one pending set, read by a
 *   single refresh once the running one ends: nothing a message asked for is lost, and each
 *   resource is read once however many messages asked for it. Everything is released on
 *   unmount.
 *
 * Reads only: a refresh replaces cached data and nothing else. An open draft (instructions being
 * revised, a file chosen for upload, a decision being made) keeps its content and the version it
 * was based on (the form shows the newer version beside it), and no write or download is ever
 * sent or retried from here.
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
    const queryKeys: Record<LiveResource, readonly unknown[]> = {
      notices: voyageQueries.notices(scope, voyageId).queryKey,
      documentaryInstructions: voyageQueries.documentaryInstructions(scope, voyageId).queryKey,
      documents: voyageQueries.documents(scope, voyageId).queryKey,
      timeline: voyageQueries.timeline(scope, voyageId).queryKey,
    };
    let stopped = false;
    const isCurrent = () => !stopped && isCurrentSession(queryClient, epoch);

    let refreshing = false;
    /** Resources a message asked for that no refresh has started reading yet. */
    const pending = new Set<LiveResource>();
    const refresh = (resources: readonly LiveResource[]) => {
      if (!isCurrent()) return;
      for (const resource of resources) pending.add(resource);
      if (refreshing || pending.size === 0) return;
      refreshing = true;
      const batch = [...pending];
      pending.clear();
      void Promise.allSettled(
        batch.map(async (resource) => {
          const queryKey = queryKeys[resource];
          // A read already on its way was sent before this message, so its answer may predate
          // the change. Invalidating alone would wait for it when the query has no data yet
          // (the first load): cancel it, so the refresh always sends a read of its own.
          await queryClient.cancelQueries({ queryKey, exact: true });
          await queryClient.invalidateQueries({ queryKey, exact: true });
        }),
      ).finally(() => {
        refreshing = false;
        // Whatever messages asked for meanwhile, each resource once.
        refresh([]);
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
          refresh(REFRESHED_BY[message.type]);
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
      pending.clear();
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
