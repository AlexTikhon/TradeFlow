import {
  type DocumentaryInstruction,
  type DocumentaryInstructionContent,
  type DocumentaryInstructionListResponse,
  DocumentaryInstructionListResponseSchema,
  DocumentaryInstructionSchema,
  instructionEntityTag,
} from '@tradeflow/contracts';
import { getJson, postJson, putJson } from '../../../shared/api/http-client';

const voyagePath = (voyageId: string) => `/voyages/${encodeURIComponent(voyageId)}`;
const instructionPath = (voyageId: string, contractId: string) =>
  `${voyagePath(voyageId)}/contracts/${encodeURIComponent(contractId)}/documentary-instructions`;

/** The instructions under the signed-in organization's contracts on the voyage. */
export function fetchDocumentaryInstructions(
  voyageId: string,
  signal?: AbortSignal,
): Promise<DocumentaryInstructionListResponse> {
  return getJson(
    `${voyagePath(voyageId)}/documentary-instructions`,
    DocumentaryInstructionListResponseSchema,
    { ...(signal && { signal }) },
  );
}

/**
 * Writes a new revision. `basedOnVersion` is the version the user's draft started from: the
 * write succeeds only if the instructions are still at that version (`If-Match`). Null means
 * there were none when the draft started: it succeeds only if there still are none
 * (`If-None-Match: *`). Either way the server answers 412 rather than overwrite a change the
 * user has not seen.
 */
export function putDocumentaryInstruction(
  voyageId: string,
  contractId: string,
  content: DocumentaryInstructionContent,
  basedOnVersion: number | null,
): Promise<DocumentaryInstruction> {
  return putJson(instructionPath(voyageId, contractId), content, DocumentaryInstructionSchema, {
    headers:
      basedOnVersion === null
        ? { 'If-None-Match': '*' }
        : { 'If-Match': instructionEntityTag(basedOnVersion) },
  });
}

/**
 * Acknowledges receipt of revision `revisionNumber`, as read at `version`. The server decides who
 * acknowledged and when, and answers 412 if the instructions changed since that read.
 */
export function acknowledgeInstructionRevision(
  voyageId: string,
  contractId: string,
  revisionNumber: number,
  version: number,
): Promise<DocumentaryInstruction> {
  return postJson(
    `${instructionPath(voyageId, contractId)}/revisions/${revisionNumber}/acknowledgement`,
    {},
    DocumentaryInstructionSchema,
    { headers: { 'If-Match': instructionEntityTag(version) } },
  );
}
