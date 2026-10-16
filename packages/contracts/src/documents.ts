import { z } from 'zod';
import { RequiredDocumentTypeSchema } from './documentary-instructions.js';
import { apiSchemaRegistry } from './registry.js';
import { CounterpartyContractSchema } from './trade-contracts.js';
import { OrganizationRefSchema } from './voyages.js';

/*
 * Documents the seller presents under one sale contract (ADR 0013): one per document type that a
 * revision of the documentary instructions requires, for that exact revision. Only the
 * contract's two counterparties may read them; operators of the seller upload them.
 *
 * A document is never changed or deleted. Uploading a replacement adds a new **version**; every
 * earlier version keeps its bytes, file name, size, checksum, uploader and time. Uploads are
 * conditional: `If-None-Match: *` for the first version, `If-Match: "<n>"` naming the current
 * version for a replacement.
 */

/** Largest file accepted, in bytes (10 MiB). The API enforces it while receiving the upload. */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

/** The only media type accepted. The API checks the file's own signature, not just the label. */
export const DOCUMENT_MEDIA_TYPE = 'application/pdf';

/** Name of the multipart form field that carries the file. */
export const DOCUMENT_FILE_FIELD = 'file';

/** Longest file name kept for display, in characters. It never names anything in storage. */
export const DOCUMENT_FILE_NAME_MAX_LENGTH = 255;

/**
 * The file a user chooses, checked before it is sent. The API checks again, and more strictly
 * (the file must start like a PDF), whatever the browser reports.
 */
export const DocumentFileSchema = z
  .file()
  .min(1, 'The file is empty')
  .max(MAX_DOCUMENT_BYTES, 'The file is larger than 10 MiB')
  .mime([DOCUMENT_MEDIA_TYPE], 'Choose a PDF file');

/** Who uploaded a version: always the signed-in user, as resolved by the server. */
export const DocumentActorSchema = z
  .object({
    name: z.string(),
    organization: OrganizationRefSchema,
  })
  .register(apiSchemaRegistry, { id: 'DocumentActor' });

export const DocumentVersionSchema = z
  .object({
    /** 1 for the first upload, then 2, 3, ... Its entity tag is `"<number>"`. */
    number: z.int().min(1),
    /** The name the file was uploaded with, for display only. */
    fileName: z.string().min(1).max(DOCUMENT_FILE_NAME_MAX_LENGTH),
    mediaType: z.literal(DOCUMENT_MEDIA_TYPE),
    sizeBytes: z.int().min(1).max(MAX_DOCUMENT_BYTES),
    /** SHA-256 of the bytes, lowercase hex, computed by the server as it received them. */
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    uploadedAt: z.iso.datetime(),
    uploadedBy: DocumentActorSchema,
  })
  .register(apiSchemaRegistry, {
    id: 'DocumentVersion',
    description: 'One uploaded file. Its bytes and metadata never change.',
  });

export const ContractDocumentSchema = z
  .object({
    id: z.uuid(),
    voyageId: z.uuid(),
    /** The contract the document is presented under, from the reader's side. */
    contract: CounterpartyContractSchema,
    /** The revision of the documentary instructions it answers. */
    revisionNumber: z.int().min(1),
    documentType: RequiredDocumentTypeSchema,
    /** The latest upload. Its number is the document's entity tag for the next replacement. */
    currentVersion: DocumentVersionSchema,
    /** Every earlier upload, newest first. */
    previousVersions: z.array(DocumentVersionSchema),
  })
  .refine(
    (document) =>
      document.previousVersions.every(
        (version, index) => version.number === document.currentVersion.number - index - 1,
      ) && document.currentVersion.number === document.previousVersions.length + 1,
    { message: 'Versions run from the current one down to 1 without gaps' },
  )
  .register(apiSchemaRegistry, {
    id: 'ContractDocument',
    description:
      'A document the seller presents for one required document type of one instruction ' +
      'revision, with every version. Readable only by the contract’s two counterparties.',
  });

export const DocumentListResponseSchema = z
  .object({
    /**
     * In contract position order, then newest revision first, then in the order of
     * `RequiredDocumentType`. Documents of superseded revisions are included.
     */
    items: z.array(ContractDocumentSchema),
  })
  .register(apiSchemaRegistry, { id: 'DocumentListResponse' });

export const DocumentTypeParamSchema = RequiredDocumentTypeSchema;
/** A version number in a path: a positive decimal integer without sign or leading zeros. */
export const DocumentVersionNumberParamSchema = z
  .string()
  .regex(/^[1-9]\d{0,8}$/, 'Expected a version number')
  .transform(Number);

/** The entity tag of a document whose current version is `versionNumber`. */
export const documentEntityTag = (versionNumber: number): string => `"${versionNumber}"`;

export type DocumentActor = z.infer<typeof DocumentActorSchema>;
export type DocumentVersion = z.infer<typeof DocumentVersionSchema>;
export type ContractDocument = z.infer<typeof ContractDocumentSchema>;
export type DocumentListResponse = z.infer<typeof DocumentListResponseSchema>;
