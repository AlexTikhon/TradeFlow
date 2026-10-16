import type { ContractDocument, DocumentActor, DocumentVersion } from '@tradeflow/contracts';
import { aCounterpartyContract } from './notices';
import { aVoyageDetail, tradeParties } from './voyages';

const { cerrado } = tradeParties;

/** Ana operates for Cerrado, the seller under contract 1: she presents the documents. */
export const anaUploads: DocumentActor = { name: 'Ana Souza', organization: cerrado.organization };
export const brunoUploads: DocumentActor = {
  name: 'Bruno Lima',
  organization: cerrado.organization,
};

/** Typed against the shared contract, so fixtures cannot drift from what the API returns. */
export function aDocumentVersion(overrides: Partial<DocumentVersion> = {}): DocumentVersion {
  return {
    number: 1,
    fileName: 'bill-of-lading.pdf',
    mediaType: 'application/pdf',
    sizeBytes: 48_213,
    sha256: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    uploadedAt: '2030-10-16T09:00:00.000Z',
    uploadedBy: anaUploads,
    ...overrides,
  };
}

/** The bill of lading presented against revision 1 under contract 1, as Cerrado sees it. */
export function aDocument(overrides: Partial<ContractDocument> = {}): ContractDocument {
  return {
    id: '01990000-0000-7000-800b-000000000001',
    voyageId: aVoyageDetail().id,
    contract: aCounterpartyContract(),
    revisionNumber: 1,
    documentType: 'BILL_OF_LADING',
    currentVersion: aDocumentVersion(),
    previousVersions: [],
    ...overrides,
  };
}

/** `document` with a new current version on top of the one it had. */
export const replacedBy = (
  document: ContractDocument,
  version: Partial<DocumentVersion> = {},
): ContractDocument => ({
  ...document,
  currentVersion: aDocumentVersion({
    number: document.currentVersion.number + 1,
    fileName: `bill-of-lading-v${document.currentVersion.number + 1}.pdf`,
    sha256: 'c3ab8ff13720e8ad9047dd39466b3c8974e592c2fa383d4a3960714caef0c4f2',
    uploadedAt: '2030-10-17T10:30:00.000Z',
    ...version,
  }),
  previousVersions: [document.currentVersion, ...document.previousVersions],
});
