import type { QueryClient } from '@tanstack/react-query';
import { purgeProtectedData, sessionQuery } from './session';

/*
 * Tabs share one cookie jar, so signing out or in as someone else in one tab changes the
 * identity of every tab. Tabs tell each other over a BroadcastChannel; a tab that hears about a
 * change drops its protected data at once (fail closed) and asks the server who it is now.
 */

export const SESSION_CHANNEL_NAME = 'tradeflow:session';
export const SESSION_CHANGED = 'session-changed';

let channel: BroadcastChannel | undefined;

export function startSessionSync(queryClient: QueryClient): () => void {
  if (typeof BroadcastChannel === 'undefined') {
    return () => undefined;
  }
  const current = new BroadcastChannel(SESSION_CHANNEL_NAME);
  current.onmessage = (event: MessageEvent) => {
    if (event.data !== SESSION_CHANGED) return;
    void purgeProtectedData(queryClient);
    // Back to "unknown" (not "stale"), so nothing renders until the server has answered.
    void queryClient.resetQueries({ queryKey: sessionQuery.queryKey });
  };
  channel = current;
  return () => {
    current.close();
    if (channel === current) channel = undefined;
  };
}

/** Tells other tabs that this tab signed in or out. A tab never receives its own message. */
export function announceSessionChange(): void {
  channel?.postMessage(SESSION_CHANGED);
}
