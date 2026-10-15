import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { IssueNoticeRequest, Notice, NoticeListResponse } from '@tradeflow/contracts';
import { ApiError } from '../../../shared/api/http-client';
import { isCurrentIdentity, useIdentity, useProtectedScope } from '../../../shared/auth/identity';
import { sendForCurrentSession } from '../../auth/session';
import { acknowledgeNotice, issueNotice } from '../api/notices.api';
import { voyageQueries } from '../api/voyage.queries';

/*
 * Notice commands for the identity the panel renders under, with the same protections as
 * voyage creation (`useCreateVoyage`):
 *
 * - A 401 for the session the request was sent under signs out locally; a 401 that speaks for a
 *   session already replaced changes nothing (`sendForCurrentSession`).
 * - A response that arrives after that identity is gone (signed out, replaced in another tab)
 *   writes nothing to the cache: it now belongs to someone else.
 * - Writes are never retried automatically. The user decides whether to try again.
 */

function useNoticeCache(voyageId: string) {
  const queryClient = useQueryClient();
  const identity = useIdentity();
  const scope = useProtectedScope();
  const { queryKey } = voyageQueries.notices(scope, voyageId);
  return {
    queryClient,
    stillSignedIn: () => isCurrentIdentity(queryClient, identity),
    refresh: () => queryClient.invalidateQueries({ queryKey }),
    replace: (notice: Notice) => {
      queryClient.setQueryData<NoticeListResponse>(
        queryKey,
        (list) =>
          list && { items: list.items.map((item) => (item.id === notice.id ? notice : item)) },
      );
    },
  };
}

/** Issues an ETA notice on the voyage, then refreshes that identity's notice list. */
export function useIssueNotice(voyageId: string) {
  const cache = useNoticeCache(voyageId);

  const mutation = useMutation({
    mutationFn: (request: IssueNoticeRequest) =>
      sendForCurrentSession(cache.queryClient, () => issueNotice(voyageId, request)),
    // Runs even if the form has unmounted meanwhile: the list must show the new notice.
    onSuccess: () => {
      if (cache.stillSignedIn()) void cache.refresh();
    },
  });

  const issue = (request: IssueNoticeRequest, onIssued: (notice: Notice) => void) => {
    mutation.mutate(request, {
      // Only while the form is still mounted, and still for the same identity.
      onSuccess: (notice) => {
        if (cache.stillSignedIn()) onIssued(notice);
      },
    });
  };

  return { issue, error: mutation.error, isPending: mutation.isPending, reset: mutation.reset };
}

/**
 * Acknowledges receipt of one notice. On success the notice is replaced in the list at once. A
 * 409 means someone else acknowledged it first: the list is refreshed so the user sees who did,
 * and the attempt is reported, not repeated.
 */
export function useAcknowledgeNotice(voyageId: string) {
  const cache = useNoticeCache(voyageId);

  const mutation = useMutation({
    mutationFn: (noticeId: string) =>
      sendForCurrentSession(cache.queryClient, () => acknowledgeNotice(voyageId, noticeId)),
    onSuccess: (notice) => {
      if (!cache.stillSignedIn()) return;
      cache.replace(notice);
      void cache.refresh();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409 && cache.stillSignedIn()) {
        void cache.refresh();
      }
    },
  });

  return {
    acknowledge: (noticeId: string) => {
      mutation.mutate(noticeId);
    },
    error: mutation.error,
    isPending: mutation.isPending,
  };
}
