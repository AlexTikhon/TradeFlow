import {
  type ContractDocument,
  ContractDocumentSchema,
  DOCUMENT_FILE_FIELD,
  DOCUMENT_MEDIA_TYPE,
  type DocumentListResponse,
  DocumentListResponseSchema,
  documentEntityTag,
  type RequiredDocumentType,
  type ReviewDocumentVersionRequest,
} from '@tradeflow/contracts';
import { getBlob, getJson, postFile, postJson } from '../../../shared/api/http-client';

/** One document: a document type required by one revision of a contract's instructions. */
export interface DocumentTarget {
  voyageId: string;
  contractId: string;
  revisionNumber: number;
  documentType: RequiredDocumentType;
}

const voyagePath = (voyageId: string) => `/voyages/${encodeURIComponent(voyageId)}`;
const versionsPath = ({ voyageId, contractId, revisionNumber, documentType }: DocumentTarget) =>
  `${voyagePath(voyageId)}/contracts/${encodeURIComponent(contractId)}/documentary-instructions` +
  `/revisions/${revisionNumber}/documents/${documentType}/versions`;

/** The documents under the signed-in organization's contracts on the voyage. */
export function fetchDocuments(
  voyageId: string,
  signal?: AbortSignal,
): Promise<DocumentListResponse> {
  return getJson(`${voyagePath(voyageId)}/documents`, DocumentListResponseSchema, {
    ...(signal && { signal }),
  });
}

/**
 * Uploads `file` as the document's next file version. `basedOnVersion` is the document version
 * (which counts uploads and reviews) the user saw when they chose to replace it (`If-Match`);
 * null means there was no document, and the upload succeeds only if there still is none
 * (`If-None-Match: *`). Either way the server answers 412 rather than replace a file, or pass
 * over a decision, the user has not seen.
 */
export function uploadDocumentVersion(
  target: DocumentTarget,
  file: File,
  basedOnVersion: number | null,
): Promise<ContractDocument> {
  return postFile(versionsPath(target), DOCUMENT_FILE_FIELD, file, ContractDocumentSchema, {
    headers:
      basedOnVersion === null
        ? { 'If-None-Match': '*' }
        : { 'If-Match': documentEntityTag(basedOnVersion) },
  });
}

/**
 * Approves or rejects file version `versionNumber`, at the document version `basedOnVersion` the
 * user saw (`If-Match`). The server answers 412 if anything changed since (a new file, or
 * someone else's decision), and 409 if the version is no longer the latest or already decided.
 */
export function reviewDocumentVersion(
  target: DocumentTarget,
  versionNumber: number,
  decision: ReviewDocumentVersionRequest,
  basedOnVersion: number,
): Promise<ContractDocument> {
  return postJson(
    `${versionsPath(target)}/${versionNumber}/review`,
    decision,
    ContractDocumentSchema,
    {
      headers: { 'If-Match': documentEntityTag(basedOnVersion) },
    },
  );
}

/** The bytes of version `versionNumber`, fetched with the session. */
export function downloadDocumentVersion(
  target: DocumentTarget,
  versionNumber: number,
): Promise<Blob> {
  return getBlob(`${versionsPath(target)}/${versionNumber}/content`, DOCUMENT_MEDIA_TYPE);
}
