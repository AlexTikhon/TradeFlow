import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ContractDocument, DocumentListResponse } from '@tradeflow/contracts';
import { ApiError } from '../../../shared/api/http-client';
import { isCurrentIdentity, useIdentity, useProtectedScope } from '../../../shared/auth/identity';
import { saveFile } from '../../../shared/lib/save-file';
import {
  currentSessionEpoch,
  isCurrentSession,
  type SessionEpoch,
  sendForCurrentSession,
} from '../../auth/session';
import {
  type DocumentTarget,
  downloadDocumentVersion,
  uploadDocumentVersion,
} from '../api/documents.api';
import { voyageQueries } from '../api/voyage.queries';

/*
 * Document commands for the identity the card renders under, with the same protections as the
 * other writes (`useSubmitInstruction`, `useIssueNotice`):
 *
 * - A 401 for the session the request was sent under signs out locally; a 401 that speaks for a
 *   session already replaced changes nothing (`sendForCurrentSession`).
 * - Each command is tied to the session it was issued in (its epoch, captured when issued and
 *   carried in its own variables, so overlapping commands never share one). A response that
 *   arrives once that session has ended writes nothing to the cache, refreshes nothing, calls
 *   no completion callback, and a download is not saved: even if the same user has signed back
 *   in meanwhile, and even if the component that issued it has unmounted.
 * - Uploads are never retried automatically. A 412 (someone uploaded a version since the user
 *   chose what to replace) is reported, never resolved by re-sending against the newer version.
 */

function useDocumentCache(voyageId: string) {
  const queryClient = useQueryClient();
  const identity = useIdentity();
  const scope = useProtectedScope();
  const { queryKey } = voyageQueries.documents(scope, voyageId);
  return {
    queryClient,
    /** The session as it stands now, to tie a command to. */
    epoch: () => currentSessionEpoch(queryClient),
    /** Whether the session `epoch` was taken in is still current, for this card's identity. */
    stillCurrent: (epoch: SessionEpoch) =>
      isCurrentSession(queryClient, epoch) && isCurrentIdentity(queryClient, identity),
    refresh: () => queryClient.invalidateQueries({ queryKey }),
    /** The instructions too: a 409 means they moved on to a new revision. */
    refreshInstructions: () =>
      queryClient.invalidateQueries({
        queryKey: voyageQueries.documentaryInstructions(scope, voyageId).queryKey,
      }),
    /** Puts `document` in the list, unless the list holds a newer version of it. */
    store: (document: ContractDocument) => {
      queryClient.setQueryData<DocumentListResponse>(queryKey, (list) => {
        if (!list) return list;
        const existing = list.items.find((item) => item.id === document.id);
        if (existing && existing.currentVersion.number >= document.currentVersion.number) {
          return list;
        }
        return {
          items: existing
            ? list.items.map((item) => (item.id === document.id ? document : item))
            : [...list.items, document],
        };
      });
    },
  };
}

/** A command and the session it was issued in. */
type InSession<T> = T & { epoch: SessionEpoch };

export interface UploadDocument {
  target: DocumentTarget;
  file: File;
  /** The version the user chose to replace; null when there was none. */
  basedOnVersion: number | null;
}

/** Someone uploaded a version since the user chose what to replace (or the first one). */
export const isPreconditionFailure = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 412;

/** The instructions have a newer revision: documents now go against that one. */
export const isSuperseded = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 409;

/** Uploads a file as a document's next version. */
export function useUploadDocument(voyageId: string) {
  const cache = useDocumentCache(voyageId);

  const mutation = useMutation({
    mutationFn: ({ target, file, basedOnVersion }: InSession<UploadDocument>) =>
      sendForCurrentSession(cache.queryClient, () =>
        uploadDocumentVersion(target, file, basedOnVersion),
      ),
    // Runs even if the form has unmounted meanwhile: the list must show the new version.
    onSuccess: (document, { epoch }) => {
      if (!cache.stillCurrent(epoch)) return;
      cache.store(document);
      void cache.refresh();
    },
    onError: (error, { epoch }) => {
      if (isSuperseded(error) && cache.stillCurrent(epoch)) {
        void cache.refresh();
        void cache.refreshInstructions();
      }
    },
  });

  const upload = (variables: UploadDocument, onUploaded: (document: ContractDocument) => void) => {
    mutation.mutate(
      { ...variables, epoch: cache.epoch() },
      {
        // Only while the form is still mounted, and still in the same session.
        onSuccess: (document, { epoch }) => {
          if (cache.stillCurrent(epoch)) onUploaded(document);
        },
      },
    );
  };

  return {
    upload,
    error: mutation.error,
    isPending: mutation.isPending,
    reset: mutation.reset,
  };
}

export interface DownloadDocument {
  target: DocumentTarget;
  versionNumber: number;
  fileName: string;
}

/**
 * Downloads one version with the session, and saves it only if the session it was asked in is
 * still the current one. A plain link would also carry the cookie, but its 401 would land the user
 * on an error page instead of signing them out.
 */
export function useDownloadDocument(voyageId: string) {
  const cache = useDocumentCache(voyageId);

  const mutation = useMutation({
    mutationFn: ({ target, versionNumber }: InSession<DownloadDocument>) =>
      sendForCurrentSession(cache.queryClient, () =>
        downloadDocumentVersion(target, versionNumber),
      ),
    onSuccess: (blob, { fileName, epoch }) => {
      if (cache.stillCurrent(epoch)) saveFile(blob, fileName);
    },
  });

  return {
    download: (variables: DownloadDocument) => {
      mutation.mutate({ ...variables, epoch: cache.epoch() });
    },
    error: mutation.error,
    /** The version being downloaded, if any. */
    pending: mutation.isPending ? mutation.variables : undefined,
  };
}
