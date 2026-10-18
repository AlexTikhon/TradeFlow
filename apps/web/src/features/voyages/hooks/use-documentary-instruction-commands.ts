import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  DocumentaryInstruction,
  DocumentaryInstructionContent,
  DocumentaryInstructionListResponse,
} from '@tradeflow/contracts';
import { ApiError } from '../../../shared/api/http-client';
import { isCurrentIdentity, useIdentity, useProtectedScope } from '../../../shared/auth/identity';
import {
  currentSessionEpoch,
  isCurrentSession,
  type SessionEpoch,
  sendForCurrentSession,
} from '../../auth/session';
import {
  acknowledgeInstructionRevision,
  putDocumentaryInstruction,
} from '../api/documentary-instructions.api';
import { voyageQueries } from '../api/voyage.queries';

/*
 * Documentary instruction commands for the identity the card renders under, with the same
 * protections as the other writes (`useCreateVoyage`, `useIssueNotice`):
 *
 * - Nothing is sent once the session the command was issued in has ended, even if the command
 *   was waiting for the network meanwhile. A 401 for that session signs out locally; a 401 that
 *   speaks for a session already replaced changes nothing (`sendForCurrentSession`).
 * - Each command is tied to the session it was issued in (its epoch, captured when issued and
 *   carried in its own variables, so overlapping commands never share one). A response that
 *   arrives once that session has ended writes nothing to the cache, refreshes nothing, calls
 *   no completion callback and shows no error: even if the same user has signed back in
 *   meanwhile, and even if the component that issued it has unmounted.
 * - Writes are never retried automatically. A 412 (the instructions changed since the user's
 *   read) is reported, never resolved by re-sending with a newer version: only the user, having
 *   seen the newer version, may decide to base a write on it.
 */

/** The instructions changed since the version a write was based on (or appeared meanwhile). */
export const isPreconditionFailure = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 412;

function useInstructionCache(voyageId: string) {
  const queryClient = useQueryClient();
  const identity = useIdentity();
  const scope = useProtectedScope();
  const { queryKey } = voyageQueries.documentaryInstructions(scope, voyageId);
  return {
    queryClient,
    /** The session as it stands now, to tie a command to. */
    epoch: () => currentSessionEpoch(queryClient),
    /** Whether the session `epoch` was taken in is still current, for this card's identity. */
    stillCurrent: (epoch: SessionEpoch) =>
      isCurrentSession(queryClient, epoch) && isCurrentIdentity(queryClient, identity),
    refresh: () => queryClient.invalidateQueries({ queryKey }),
    /** Puts `instruction` in the list, in contract order, unless the list holds a newer one. */
    store: (instruction: DocumentaryInstruction) => {
      queryClient.setQueryData<DocumentaryInstructionListResponse>(queryKey, (list) => {
        if (!list) return list;
        const existing = list.items.find((item) => item.id === instruction.id);
        if (existing && existing.version >= instruction.version) return list;
        const items = [
          ...list.items.filter((item) => item.contract.id !== instruction.contract.id),
          instruction,
        ].sort((a, b) => a.contract.position - b.contract.position);
        return { items };
      });
    },
  };
}

/** A command and the session it was issued in. */
type InSession<T> = T & { epoch: SessionEpoch };

export interface SubmitInstruction {
  contractId: string;
  content: DocumentaryInstructionContent;
  /** The version the draft was based on; null when there were no instructions yet. */
  basedOnVersion: number | null;
}

/** Gives or revises the instructions under one contract. */
export function useSubmitInstruction(voyageId: string) {
  const cache = useInstructionCache(voyageId);

  const mutation = useMutation({
    mutationFn: ({ contractId, content, basedOnVersion, epoch }: InSession<SubmitInstruction>) =>
      sendForCurrentSession(cache.queryClient, epoch, () =>
        putDocumentaryInstruction(voyageId, contractId, content, basedOnVersion),
      ),
    // Runs even if the form has unmounted meanwhile: the list must show the new revision.
    onSuccess: (instruction, { epoch }) => {
      if (!cache.stillCurrent(epoch)) return;
      cache.store(instruction);
      void cache.refresh();
    },
  });

  const submit = (
    variables: SubmitInstruction,
    onSaved: (instruction: DocumentaryInstruction) => void,
  ) => {
    mutation.mutate(
      { ...variables, epoch: cache.epoch() },
      {
        // Only while the form is still mounted, and still in the same session.
        onSuccess: (instruction, { epoch }) => {
          if (cache.stillCurrent(epoch)) onSaved(instruction);
        },
      },
    );
  };

  // An outcome speaks only for the session it was issued in, should this component outlive it.
  const ownSession =
    mutation.variables !== undefined && cache.stillCurrent(mutation.variables.epoch);
  return {
    submit,
    error: ownSession ? mutation.error : null,
    isPending: mutation.isPending,
    isSuccess: ownSession && mutation.isSuccess,
    reset: mutation.reset,
  };
}

/**
 * Acknowledges receipt of the revision the user is looking at, at the version it was read. On
 * a 412 or 409 the list is refreshed so the user sees what changed; acknowledging the newer
 * revision is again the user's decision.
 */
export function useAcknowledgeRevision(voyageId: string) {
  const cache = useInstructionCache(voyageId);

  const mutation = useMutation({
    mutationFn: ({ instruction, epoch }: InSession<{ instruction: DocumentaryInstruction }>) =>
      sendForCurrentSession(cache.queryClient, epoch, () =>
        acknowledgeInstructionRevision(
          voyageId,
          instruction.contract.id,
          instruction.currentRevision.number,
          instruction.version,
        ),
      ),
    // Runs even if the card has unmounted meanwhile: the list must show the acknowledgement.
    onSuccess: (instruction, { epoch }) => {
      if (!cache.stillCurrent(epoch)) return;
      cache.store(instruction);
      void cache.refresh();
    },
    onError: (error, { epoch }) => {
      if (
        error instanceof ApiError &&
        (error.status === 409 || error.status === 412) &&
        cache.stillCurrent(epoch)
      ) {
        void cache.refresh();
      }
    },
  });

  const ownSession =
    mutation.variables !== undefined && cache.stillCurrent(mutation.variables.epoch);
  return {
    acknowledge: (instruction: DocumentaryInstruction) => {
      mutation.mutate({ instruction, epoch: cache.epoch() });
    },
    error: ownSession ? mutation.error : null,
    isPending: mutation.isPending,
  };
}
