import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  ContractDocument,
  DocumentListResponse,
  ReviewDocumentVersionRequest,
} from '@tradeflow/contracts';
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
  reviewDocumentVersion,
  uploadDocumentVersion,
} from '../api/documents.api';
import { voyageQueries } from '../api/voyage.queries';

/*
 * Document commands for the identity the card renders under, with the same protections as the
 * other writes (`useSubmitInstruction`, `useIssueNotice`):
 *
 * - Nothing is sent once the session the command was issued in has ended, even if the command
 *   was waiting for the network meanwhile. A 401 for that session signs out locally; a 401 that
 *   speaks for a session already replaced changes nothing (`sendForCurrentSession`).
 * - Each command is tied to the session it was issued in (its epoch, captured when issued and
 *   carried in its own variables, so overlapping commands never share one). A response that
 *   arrives once that session has ended writes nothing to the cache, refreshes nothing, calls
 *   no completion callback, and a download is not saved: even if the same user has signed back
 *   in meanwhile, and even if the component that issued it has unmounted.
 * - Uploads and reviews are never retried automatically. A 412 (someone uploaded a file, or made
 *   a decision, since the user's draft was based) is reported, never resolved by re-sending
 *   against the newer version: only the user, having seen it, may base a write on it.
 * - The cache keeps the newest document by its version, which counts uploads and decisions: a
 *   response for an older version never overwrites a newer one already shown.
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
    /** Puts `document` in the list, unless the list holds it at the same or a newer version. */
    store: (document: ContractDocument) => {
      queryClient.setQueryData<DocumentListResponse>(queryKey, (list) => {
        if (!list) return list;
        const existing = list.items.find((item) => item.id === document.id);
        if (existing && existing.version >= document.version) {
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
  /** The document version the user chose to replace; null when there was no document. */
  basedOnVersion: number | null;
}

/** The document changed (a new file or a decision) since the user's draft was based on it. */
export const isPreconditionFailure = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 412;

/**
 * For an upload: the instructions have a newer revision, documents now go against that one. For
 * a review, also: the version was replaced, or already decided.
 */
export const isSuperseded = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 409;

/** Uploads a file as a document's next version. */
export function useUploadDocument(voyageId: string) {
  const cache = useDocumentCache(voyageId);

  const mutation = useMutation({
    mutationFn: ({ target, file, basedOnVersion, epoch }: InSession<UploadDocument>) =>
      sendForCurrentSession(cache.queryClient, epoch, () =>
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

export interface ReviewDocument {
  target: DocumentTarget;
  /** The file version decided on. */
  versionNumber: number;
  decision: ReviewDocumentVersionRequest;
  /** The document version the user saw when they started deciding (If-Match). */
  basedOnVersion: number;
}

/**
 * Approves or rejects one file version. On a 412 or 409 the documents are refreshed so the user
 * sees what changed (a new file, or someone else's decision), and on a 409 the instructions too
 * (a new revision); deciding again is the user's choice, and only when there is still something
 * to decide.
 */
export function useReviewDocument(voyageId: string) {
  const cache = useDocumentCache(voyageId);

  const mutation = useMutation({
    mutationFn: ({
      target,
      versionNumber,
      decision,
      basedOnVersion,
      epoch,
    }: InSession<ReviewDocument>) =>
      sendForCurrentSession(cache.queryClient, epoch, () =>
        reviewDocumentVersion(target, versionNumber, decision, basedOnVersion),
      ),
    // Runs even if the form has unmounted meanwhile: the list must show the decision.
    onSuccess: (document, { epoch }) => {
      if (!cache.stillCurrent(epoch)) return;
      cache.store(document);
      void cache.refresh();
    },
    onError: (error, { epoch }) => {
      if (!cache.stillCurrent(epoch)) return;
      if (isPreconditionFailure(error) || isSuperseded(error)) void cache.refresh();
      if (isSuperseded(error)) void cache.refreshInstructions();
    },
  });

  const review = (variables: ReviewDocument, onReviewed: (document: ContractDocument) => void) => {
    mutation.mutate(
      { ...variables, epoch: cache.epoch() },
      {
        // Only while the form is still mounted, and still in the same session.
        onSuccess: (document, { epoch }) => {
          if (cache.stillCurrent(epoch)) onReviewed(document);
        },
      },
    );
  };

  return {
    review,
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
    mutationFn: ({ target, versionNumber, epoch }: InSession<DownloadDocument>) =>
      sendForCurrentSession(cache.queryClient, epoch, () =>
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
