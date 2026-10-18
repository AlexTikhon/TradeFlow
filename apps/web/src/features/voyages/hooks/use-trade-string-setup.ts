import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ConfigureTradeStringRequest, TradeString } from '@tradeflow/contracts';
import { ApiError } from '../../../shared/api/http-client';
import { isCurrentIdentity, useIdentity, useProtectedScope } from '../../../shared/auth/identity';
import {
  currentSessionEpoch,
  isCurrentSession,
  type SessionEpoch,
  sendForCurrentSession,
} from '../../auth/session';
import { voyageQueries } from '../api/voyage.queries';
import { configureTradeString } from '../api/voyages.api';

/*
 * Setting up a new voyage's trade string (ADR 0016), with the protections of every other write
 * (`useUploadDocument`, `useReviewDocument`):
 *
 * - One plain POST, never retried and never re-sent on its own: a second attempt is the user's.
 * - The command is tied to the session it was issued in (its epoch, captured when issued and
 *   carried in its own variables). A response that arrives once that session has ended writes
 *   nothing to the cache, refreshes nothing and calls no completion callback: even if the same
 *   user has signed back in meanwhile, and even if the form has unmounted.
 * - Nothing is sent once the session the command was issued in has ended, even if the command
 *   was waiting for the network meanwhile. A 401 for that session signs out locally; one that
 *   speaks for a session already replaced changes nothing (`sendForCurrentSession`).
 * - On 200 and on 409 the identity's view of the voyage is refreshed: its detail prefix (the
 *   participants, the string, its own contracts and every panel under it) and the voyage lists.
 *   After a 409 that refetch is what says why: the string someone else recorded, or the state
 *   that makes setup unavailable.
 */

/** The voyage cannot be set up (anymore): already set up, not planned, or other participants. */
export const isSetupConflict = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 409;

type InSession<T> = T & { epoch: SessionEpoch };

export function useConfigureTradeString(voyageId: string) {
  const queryClient = useQueryClient();
  const identity = useIdentity();
  const scope = useProtectedScope();
  const stillCurrent = (epoch: SessionEpoch) =>
    isCurrentSession(queryClient, epoch) && isCurrentIdentity(queryClient, identity);
  const refresh = () => {
    void queryClient.invalidateQueries({
      queryKey: voyageQueries.detail(scope, voyageId).queryKey,
    });
    void queryClient.invalidateQueries({ queryKey: voyageQueries.lists(scope) });
  };

  const mutation = useMutation({
    mutationFn: ({ request, epoch }: InSession<{ request: ConfigureTradeStringRequest }>) =>
      sendForCurrentSession(queryClient, epoch, () => configureTradeString(voyageId, request)),
    // Runs even if the form has unmounted meanwhile: the page must show the recorded string.
    onSuccess: (tradeString, { epoch }) => {
      if (!stillCurrent(epoch)) return;
      queryClient.setQueryData(voyageQueries.tradeString(scope, voyageId).queryKey, tradeString);
      refresh();
    },
    onError: (error, { epoch }) => {
      if (isSetupConflict(error) && stillCurrent(epoch)) refresh();
    },
  });

  const configure = (
    request: ConfigureTradeStringRequest,
    onConfigured: (tradeString: TradeString) => void,
  ) => {
    mutation.mutate(
      { request, epoch: currentSessionEpoch(queryClient) },
      {
        // Only while the form is still mounted, and still in the same session.
        onSuccess: (tradeString, { epoch }) => {
          if (stillCurrent(epoch)) onConfigured(tradeString);
        },
      },
    );
  };

  // An outcome speaks only for the session it was issued in, should this component outlive it.
  const ownSession = mutation.variables !== undefined && stillCurrent(mutation.variables.epoch);
  return {
    configure,
    error: ownSession ? mutation.error : null,
    isPending: mutation.isPending,
    isSuccess: ownSession && mutation.isSuccess,
    reset: mutation.reset,
  };
}
