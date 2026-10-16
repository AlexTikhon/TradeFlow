import {
  type ContractDocument,
  ContractDocumentSchema,
  DOCUMENT_FILE_FIELD,
  DOCUMENT_MEDIA_TYPE,
  type DocumentListResponse,
  DocumentListResponseSchema,
  documentEntityTag,
  type RequiredDocumentType,
} from '@tradeflow/contracts';
import { getBlob, getJson, postFile } from '../../../shared/api/http-client';

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
 * Uploads `file` as the document's next version. `basedOnVersion` is the version the user chose
 * to replace (`If-Match`); null means there was none, and the upload succeeds only if there
 * still is none (`If-None-Match: *`). Either way the server answers 412 rather than replace a
 * version the user has not seen.
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

/** The bytes of version `versionNumber`, fetched with the session. */
export function downloadDocumentVersion(
  target: DocumentTarget,
  versionNumber: number,
): Promise<Blob> {
  return getBlob(`${versionsPath(target)}/${versionNumber}/content`, DOCUMENT_MEDIA_TYPE);
}
