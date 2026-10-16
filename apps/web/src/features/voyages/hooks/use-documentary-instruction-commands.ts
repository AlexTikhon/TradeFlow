import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  DocumentaryInstruction,
  DocumentaryInstructionContent,
  DocumentaryInstructionListResponse,
} from '@tradeflow/contracts';
import { ApiError } from '../../../shared/api/http-client';
import { isCurrentIdentity, useIdentity, useProtectedScope } from '../../../shared/auth/identity';
import { sendForCurrentSession } from '../../auth/session';
import {
  acknowledgeInstructionRevision,
  putDocumentaryInstruction,
} from '../api/documentary-instructions.api';
import { voyageQueries } from '../api/voyage.queries';

/*
 * Documentary instruction commands for the identity the card renders under, with the same
 * protections as the other writes (`useCreateVoyage`, `useIssueNotice`):
 *
 * - A 401 for the session the request was sent under signs out locally; a 401 that speaks for a
 *   session already replaced changes nothing (`sendForCurrentSession`).
 * - A response that arrives after that identity is gone writes nothing to the cache.
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
    stillSignedIn: () => isCurrentIdentity(queryClient, identity),
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
    mutationFn: ({ contractId, content, basedOnVersion }: SubmitInstruction) =>
      sendForCurrentSession(cache.queryClient, () =>
        putDocumentaryInstruction(voyageId, contractId, content, basedOnVersion),
      ),
    // Runs even if the form has unmounted meanwhile: the list must show the new revision.
    onSuccess: (instruction) => {
      if (!cache.stillSignedIn()) return;
      cache.store(instruction);
      void cache.refresh();
    },
  });

  const submit = (
    variables: SubmitInstruction,
    onSaved: (instruction: DocumentaryInstruction) => void,
  ) => {
    mutation.mutate(variables, {
      // Only while the form is still mounted, and still for the same identity.
      onSuccess: (instruction) => {
        if (cache.stillSignedIn()) onSaved(instruction);
      },
    });
  };

  return {
    submit,
    error: mutation.error,
    isPending: mutation.isPending,
    isSuccess: mutation.isSuccess,
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
    mutationFn: (instruction: DocumentaryInstruction) =>
      sendForCurrentSession(cache.queryClient, () =>
        acknowledgeInstructionRevision(
          voyageId,
          instruction.contract.id,
          instruction.currentRevision.number,
          instruction.version,
        ),
      ),
    onSuccess: (instruction) => {
      if (!cache.stillSignedIn()) return;
      cache.store(instruction);
      void cache.refresh();
    },
    onError: (error) => {
      if (
        error instanceof ApiError &&
        (error.status === 409 || error.status === 412) &&
        cache.stillSignedIn()
      ) {
        void cache.refresh();
      }
    },
  });

  return {
    acknowledge: (instruction: DocumentaryInstruction) => {
      mutation.mutate(instruction);
    },
    error: mutation.error,
    isPending: mutation.isPending,
  };
}
