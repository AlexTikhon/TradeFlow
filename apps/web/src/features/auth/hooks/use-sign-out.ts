import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { useCallback, useSyncExternalStore } from 'react';
import {
  endSession,
  getSignOutState,
  signedOutHere,
  type SignOutState,
  subscribeToSignOutState,
} from '../session';
import { announceSessionChange } from '../session-sync';

/**
 * Signs out, or retries a sign-out the server did not confirm. The sign-out itself belongs to
 * the query client, not to the calling component, so it completes (and is reported through
 * `useSignOutState`) even though the caller unmounts on the way to the sign-in page.
 *
 * It does not navigate: once nobody is signed in, the auth boundary (`RequireAuth`) is the one
 * that leaves the protected page, and it knows from `useSignedOutHere` not to come back to it.
 * One navigation, whatever order React renders in and the server answers in.
 */
export function useSignOut(): () => Promise<void> {
  const queryClient = useQueryClient();

  return useCallback(async () => {
    // Local first: this identity's requests stop and its data disappears immediately,
    // whether or not the server is reachable.
    const { settled } = endSession(queryClient);
    await settled;
    if (getSignOutState(queryClient).status === 'idle') {
      // Only a confirmed sign-out changed the shared cookie.
      announceSessionChange();
    }
  }, [queryClient]);
}

function useSignOutStore<T>(getSnapshot: (queryClient: QueryClient) => T): T {
  const queryClient = useQueryClient();
  const subscribe = useCallback(
    (listener: () => void) => subscribeToSignOutState(queryClient, listener),
    [queryClient],
  );
  return useSyncExternalStore(subscribe, () => getSnapshot(queryClient));
}

/** Whether a sign-out is waiting for the server, or was not confirmed by it. */
export function useSignOutState(): SignOutState {
  return useSignOutStore(getSignOutState);
}

/** Whether this tab's own sign-out ended the session (see `signedOutHere`). */
export function useSignedOutHere(): boolean {
  return useSignOutStore(signedOutHere);
}
