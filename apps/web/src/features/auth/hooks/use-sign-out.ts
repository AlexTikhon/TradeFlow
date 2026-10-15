import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { useNavigate } from 'react-router';
import { signOut } from '../api/auth.api';
import { sessionQuery, switchIdentity } from '../session';
import { announceSessionChange } from '../session-sync';

export function useSignOut(): () => Promise<void> {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  return useCallback(async () => {
    // Local first: this identity's requests stop and its data disappears immediately,
    // whether or not the server is reachable.
    await switchIdentity(queryClient, null);
    void navigate('/sign-in', { replace: true });
    try {
      await signOut();
    } catch {
      // The session may still be alive on the server: ask it instead of assuming.
      await queryClient.invalidateQueries({ queryKey: sessionQuery.queryKey });
    }
    announceSessionChange();
  }, [queryClient, navigate]);
}
