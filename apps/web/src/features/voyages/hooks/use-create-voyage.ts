import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { CreateVoyageRequest, VoyageDetail } from '@tradeflow/contracts';
import { useNavigate } from 'react-router';
import { isCurrentIdentity, useIdentity, useProtectedScope } from '../../../shared/auth/identity';
import { voyageQueries } from '../api/voyage.queries';
import { createVoyage } from '../api/voyages.api';

/**
 * Creates a voyage for the identity this component renders under, then refreshes that
 * identity's voyage lists and opens the new voyage.
 *
 * The response can arrive after that identity is gone (signed out, replaced in another tab,
 * session expired). The cache and the location then belong to someone else, so the response
 * touches neither: no cache write, no invalidation, no navigation. It is checked when the
 * response arrives, not when the request was sent.
 */
export function useCreateVoyage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const identity = useIdentity();
  const scope = useProtectedScope();
  const stillSignedIn = () => isCurrentIdentity(queryClient, identity);

  const mutation = useMutation({
    mutationFn: (request: CreateVoyageRequest) => createVoyage(request),
    // Runs even if the form has unmounted meanwhile: the cache must reflect the new voyage.
    onSuccess: (voyage: VoyageDetail) => {
      if (!stillSignedIn()) return;
      queryClient.setQueryData(voyageQueries.detail(scope, voyage.id).queryKey, voyage);
      void queryClient.invalidateQueries({ queryKey: voyageQueries.lists(scope) });
    },
  });

  const create = (request: CreateVoyageRequest) => {
    mutation.mutate(request, {
      // Only while the form is still mounted: a user who has moved on is not pulled back.
      onSuccess: (voyage) => {
        if (stillSignedIn()) void navigate(`/voyages/${voyage.id}`);
      },
    });
  };

  return { create, error: mutation.error, isPending: mutation.isPending };
}
