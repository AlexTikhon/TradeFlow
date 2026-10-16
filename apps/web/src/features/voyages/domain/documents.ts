import type {
  ContractDocument,
  CounterpartyContract,
  CurrentUser,
  RequiredDocumentType,
} from '@tradeflow/contracts';

/*
 * Presentation rules for documents. The API decides who may do what (ADR 0013) and checks again
 * on every request, the file included; these only decide what to offer.
 */

/** Whether to offer uploads: the organization sells under the contract and the user operates. */
export const canUploadDocuments = (identity: CurrentUser, contract: CounterpartyContract) =>
  identity.user.role === 'OPERATOR' && contract.side === 'SELLER';

/** The document of `type` presented against revision `revisionNumber`, if there is one yet. */
export const findDocument = (
  documents: readonly ContractDocument[],
  contractId: string,
  revisionNumber: number,
  type: RequiredDocumentType,
): ContractDocument | null =>
  documents.find(
    (document) =>
      document.contract.id === contractId &&
      document.revisionNumber === revisionNumber &&
      document.documentType === type,
  ) ?? null;

const sizeFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

/** "48.2 KB", "3.1 MB": sizes as file managers show them (1 KB = 1024 bytes). */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${sizeFormat.format(bytes / 1024)} KB`;
  return `${sizeFormat.format(bytes / (1024 * 1024))} MB`;
}

/** The start of a checksum, enough to compare two copies by eye. */
export const shortChecksum = (sha256: string) => `${sha256.slice(0, 12)}…`;
