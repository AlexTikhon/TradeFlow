import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { CreateVoyageRequest, VoyageDetail } from '@tradeflow/contracts';
import { useNavigate } from 'react-router';
import { isCurrentIdentity, useIdentity, useProtectedScope } from '../../../shared/auth/identity';
import {
  currentSessionEpoch,
  isCurrentSession,
  type SessionEpoch,
  sendForCurrentSession,
} from '../../auth/session';
import { voyageQueries } from '../api/voyage.queries';
import { createVoyage } from '../api/voyages.api';

/**
 * Creates a voyage for the identity this component renders under, then refreshes that
 * identity's voyage lists and opens the new voyage.
 *
 * The command is tied to the session it was issued in (its epoch, captured when issued and
 * carried in its own variables). A response that arrives once that session has ended (signed
 * out, replaced in another tab, expired, or a session check adopted someone else) touches
 * nothing: no cache write, no invalidation, no navigation, and its error is not shown. That holds
 * even if the same user has signed back in meanwhile, and even if the form has unmounted.
 *
 * Nothing is sent once that session has ended, even if the request was waiting for the network
 * meanwhile. A 401 means the session the command was issued in has ended. If it is still the
 * current session, the client signs out locally; if a transition has happened since (even back
 * to the same user), or a session check has adopted another identity, the 401 is about a session
 * that is already gone and changes nothing (`sendForCurrentSession`). The write is never retried.
 */

type InSession<T> = T & { epoch: SessionEpoch };

export function useCreateVoyage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const identity = useIdentity();
  const scope = useProtectedScope();
  const stillCurrent = (epoch: SessionEpoch) =>
    isCurrentSession(queryClient, epoch) && isCurrentIdentity(queryClient, identity);

  const mutation = useMutation({
    mutationFn: ({ request, epoch }: InSession<{ request: CreateVoyageRequest }>) =>
      sendForCurrentSession(queryClient, epoch, () => createVoyage(request)),
    // Runs even if the form has unmounted meanwhile: the cache must reflect the new voyage.
    onSuccess: (voyage: VoyageDetail, { epoch }) => {
      if (!stillCurrent(epoch)) return;
      queryClient.setQueryData(voyageQueries.detail(scope, voyage.id).queryKey, voyage);
      void queryClient.invalidateQueries({ queryKey: voyageQueries.lists(scope) });
    },
  });

  const create = (request: CreateVoyageRequest) => {
    mutation.mutate(
      { request, epoch: currentSessionEpoch(queryClient) },
      {
        // Only while the form is still mounted, and still in the same session: a user who has
        // moved on is not pulled back.
        onSuccess: (voyage, { epoch }) => {
          if (stillCurrent(epoch)) void navigate(`/voyages/${voyage.id}`);
        },
      },
    );
  };

  // An outcome speaks only for the session it was issued in, should this component outlive it.
  const ownSession = mutation.variables !== undefined && stillCurrent(mutation.variables.epoch);
  return { create, error: ownSession ? mutation.error : null, isPending: mutation.isPending };
}
