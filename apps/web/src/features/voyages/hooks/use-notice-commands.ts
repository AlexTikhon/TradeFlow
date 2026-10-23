import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { IssueNoticeRequest, Notice, NoticeListResponse } from '@tradeflow/contracts';
import { ApiError } from '../../../shared/api/http-client';
import { isCurrentIdentity, useIdentity, useProtectedScope } from '../../../shared/auth/identity';
import { invalidateActionQueue } from '../../../shared/cache/action-queue';
import {
  currentSessionEpoch,
  isCurrentSession,
  type SessionEpoch,
  sendForCurrentSession,
} from '../../auth/session';
import { acknowledgeNotice, issueNotice } from '../api/notices.api';
import { voyageQueries } from '../api/voyage.queries';

/*
 * Notice commands for the identity the panel renders under, with the same protections as the
 * other writes (`useCreateVoyage`, `useUploadDocument`):
 *
 * - Nothing is sent once the session the command was issued in has ended, even if the command
 *   was waiting for the network meanwhile. A 401 for that session signs out locally; a 401 that
 *   speaks for a session already replaced changes nothing (`sendForCurrentSession`).
 * - Each command is tied to the session it was issued in (its epoch, captured when issued and
 *   carried in its own variables, so overlapping commands never share one). A response that
 *   arrives once that session has ended writes nothing to the cache, refreshes nothing, calls
 *   no completion callback and shows no error: even if the same user has signed back in
 *   meanwhile, and even if the component that issued it has unmounted.
 * - A success in that session also invalidates its Action Center queue (`invalidateActionQueue`).
 * - Writes are never retried automatically. The user decides whether to try again.
 */

function useNoticeCache(voyageId: string) {
  const queryClient = useQueryClient();
  const identity = useIdentity();
  const scope = useProtectedScope();
  const { queryKey } = voyageQueries.notices(scope, voyageId);
  return {
    queryClient,
    /** The session as it stands now, to tie a command to. */
    epoch: () => currentSessionEpoch(queryClient),
    /** Whether the session `epoch` was taken in is still current, for this panel's identity. */
    stillCurrent: (epoch: SessionEpoch) =>
      isCurrentSession(queryClient, epoch) && isCurrentIdentity(queryClient, identity),
    refresh: () => queryClient.invalidateQueries({ queryKey }),
    /** This identity's Action Center queue, which the command may have changed. */
    refreshActionQueue: () => invalidateActionQueue(queryClient, scope),
    replace: (notice: Notice) => {
      queryClient.setQueryData<NoticeListResponse>(
        queryKey,
        (list) =>
          list && { items: list.items.map((item) => (item.id === notice.id ? notice : item)) },
      );
    },
  };
}

/** A command and the session it was issued in. */
type InSession<T> = T & { epoch: SessionEpoch };

/** Issues an ETA notice on the voyage, then refreshes that identity's notice list. */
export function useIssueNotice(voyageId: string) {
  const cache = useNoticeCache(voyageId);

  const mutation = useMutation({
    mutationFn: ({ request, epoch }: InSession<{ request: IssueNoticeRequest }>) =>
      sendForCurrentSession(cache.queryClient, epoch, () => issueNotice(voyageId, request)),
    // Runs even if the form has unmounted meanwhile: the list must show the new notice.
    onSuccess: (_notice, { epoch }) => {
      if (!cache.stillCurrent(epoch)) return;
      void cache.refresh();
      void cache.refreshActionQueue();
    },
  });

  const issue = (request: IssueNoticeRequest, onIssued: (notice: Notice) => void) => {
    mutation.mutate(
      { request, epoch: cache.epoch() },
      {
        // Only while the form is still mounted, and still in the same session.
        onSuccess: (notice, { epoch }) => {
          if (cache.stillCurrent(epoch)) onIssued(notice);
        },
      },
    );
  };

  // An outcome speaks only for the session it was issued in, should this component outlive it.
  const ownSession =
    mutation.variables !== undefined && cache.stillCurrent(mutation.variables.epoch);
  return {
    issue,
    error: ownSession ? mutation.error : null,
    isPending: mutation.isPending,
    reset: mutation.reset,
  };
}

/**
 * Acknowledges receipt of one notice. On success the notice is replaced in the list at once. A
 * 409 means someone else acknowledged it first: the list is refreshed so the user sees who did,
 * and the attempt is reported, not repeated.
 */
export function useAcknowledgeNotice(voyageId: string) {
  const cache = useNoticeCache(voyageId);

  const mutation = useMutation({
    mutationFn: ({ noticeId, epoch }: InSession<{ noticeId: string }>) =>
      sendForCurrentSession(cache.queryClient, epoch, () => acknowledgeNotice(voyageId, noticeId)),
    // Runs even if the card has unmounted meanwhile: the list must show the acknowledgement.
    onSuccess: (notice, { epoch }) => {
      if (!cache.stillCurrent(epoch)) return;
      cache.replace(notice);
      void cache.refresh();
      void cache.refreshActionQueue();
    },
    onError: (error, { epoch }) => {
      if (error instanceof ApiError && error.status === 409 && cache.stillCurrent(epoch)) {
        void cache.refresh();
      }
    },
  });

  const ownSession =
    mutation.variables !== undefined && cache.stillCurrent(mutation.variables.epoch);
  return {
    acknowledge: (noticeId: string) => {
      mutation.mutate({ noticeId, epoch: cache.epoch() });
    },
    error: ownSession ? mutation.error : null,
    isPending: mutation.isPending,
  };
}
