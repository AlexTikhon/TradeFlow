import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router';
import {
  endSession,
  getSignOutState,
  type SignOutState,
  subscribeToSignOutState,
} from '../session';
import { announceSessionChange } from '../session-sync';

/**
 * Signs out, or retries a sign-out the server did not confirm. The sign-out itself belongs to
 * the query client, not to the calling component, so it completes (and is reported through
 * `useSignOutState`) even though the caller unmounts on the way to the sign-in page.
 */
export function useSignOut(): () => Promise<void> {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  return useCallback(async () => {
    // Local first: this identity's requests stop and its data disappears immediately,
    // whether or not the server is reachable.
    const { signedOutLocally, settled } = endSession(queryClient);
    await signedOutLocally;
    void navigate('/sign-in', { replace: true });
    await settled;
    if (getSignOutState(queryClient).status === 'idle') {
      // Only a confirmed sign-out changed the shared cookie.
      announceSessionChange();
    }
  }, [queryClient, navigate]);
}

/** Whether a sign-out is waiting for the server, or was not confirmed by it. */
export function useSignOutState(): SignOutState {
  const queryClient = useQueryClient();
  const subscribe = useCallback(
    (listener: () => void) => subscribeToSignOutState(queryClient, listener),
    [queryClient],
  );
  return useSyncExternalStore(subscribe, () => getSignOutState(queryClient));
}
