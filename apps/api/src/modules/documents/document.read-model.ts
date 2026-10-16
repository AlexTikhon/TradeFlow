import {
  type ContractDocument,
  type CounterpartyContract,
  DOCUMENT_MEDIA_TYPE,
  type DocumentVersion,
  REQUIRED_DOCUMENT_TYPES,
} from '@tradeflow/contracts';
import type { Prisma } from '../../generated/prisma/client.js';

/*
 * Read model for documents: exactly which columns are loaded, and how rows become the API
 * contract. The storage key is never part of a response. The contract a document belongs to is
 * not joined here: the voyages module resolves it, for the reader, through
 * `CounterpartyContracts`. Uploaders are read through the versions' own actor relations.
 */

const organizationSelect = { select: { id: true, name: true, countryCode: true } } as const;

const versionSelect = {
  versionNumber: true,
  fileName: true,
  mediaType: true,
  sizeBytes: true,
  sha256: true,
  uploadedAt: true,
  uploadedByUser: { select: { fullName: true } },
  uploadedByOrganization: organizationSelect,
} satisfies Prisma.DocumentVersionSelect;

export const documentSelect = {
  id: true,
  voyageId: true,
  tradeContractId: true,
  revisionNumber: true,
  documentType: true,
  currentVersionNumber: true,
  versions: { select: versionSelect, orderBy: { versionNumber: 'desc' } },
} satisfies Prisma.DocumentSelect;

export type DocumentRow = Prisma.DocumentGetPayload<{ select: typeof documentSelect }>;

type VersionRow = DocumentRow['versions'][number];

function toVersion(row: VersionRow): DocumentVersion {
  if (row.mediaType !== DOCUMENT_MEDIA_TYPE) {
    // A CHECK constraint allows nothing else.
    throw new Error(`Document version stored with media type ${row.mediaType}`);
  }
  return {
    number: row.versionNumber,
    fileName: row.fileName,
    mediaType: row.mediaType,
    sizeBytes: row.sizeBytes,
    sha256: Buffer.from(row.sha256).toString('hex'),
    uploadedAt: row.uploadedAt.toISOString(),
    uploadedBy: { name: row.uploadedByUser.fullName, organization: row.uploadedByOrganization },
  };
}

/** Maps a document for a reader who is a party to `contract`. */
export function toDocument(row: DocumentRow, contract: CounterpartyContract): ContractDocument {
  const [current, ...previous] = row.versions;
  if (current?.versionNumber !== row.currentVersionNumber) {
    // The deferred constraint trigger guarantees the current version exists.
    throw new Error(`Document ${row.id} was read without its current version`);
  }
  return {
    id: row.id,
    voyageId: row.voyageId,
    contract,
    revisionNumber: row.revisionNumber,
    documentType: row.documentType,
    currentVersion: toVersion(current),
    previousVersions: previous.map(toVersion),
  };
}

/** Newest revision first, then in the order of the shared list of document types. */
export const byRevisionThenType = (a: DocumentRow, b: DocumentRow): number =>
  b.revisionNumber - a.revisionNumber ||
  REQUIRED_DOCUMENT_TYPES.indexOf(a.documentType) - REQUIRED_DOCUMENT_TYPES.indexOf(b.documentType);
