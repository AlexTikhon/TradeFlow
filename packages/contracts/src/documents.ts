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
 * earlier version keeps its bytes, file name, size, checksum, uploader and time. Operators of the
 * buyer review the latest version once: approved, or rejected with a reason (ADR 0014). A
 * decision stays with the exact file version it was made on; a replacement starts pending.
 *
 * Two numbers: file versions count uploads (1, 2, 3); the document's `version` counts every
 * change, uploads and reviews, and is its entity tag. Writes are conditional on it:
 * `If-None-Match: *` for the first upload, `If-Match: "<version>"` for a replacement or a review.
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

/** What the buyer decided about one file version. Final: a decision is never changed. */
export const DOCUMENT_REVIEW_DECISIONS = ['APPROVED', 'REJECTED'] as const;

export const DocumentReviewDecisionSchema = z
  .enum(DOCUMENT_REVIEW_DECISIONS)
  .register(apiSchemaRegistry, { id: 'DocumentReviewDecision' });

/** Longest reason for a rejection, in characters. */
export const REJECTION_REASON_MAX_LENGTH = 1000;

/**
 * Body of `POST .../versions/{versionNumber}/review`: approve, or reject with a reason. The path
 * names the file version; who decided, for which organization, and when are server-side.
 */
export const ReviewDocumentVersionRequestSchema = z
  .discriminatedUnion('decision', [
    z.strictObject({ decision: z.literal('APPROVED') }),
    z.strictObject({
      decision: z.literal('REJECTED'),
      reason: z
        .string()
        .trim()
        .min(1, 'Say why the document is rejected')
        .max(REJECTION_REASON_MAX_LENGTH, `Use at most ${REJECTION_REASON_MAX_LENGTH} characters`),
    }),
  ])
  .register(apiSchemaRegistry, {
    id: 'ReviewDocumentVersionRequest',
    description:
      'Approve the file version, or reject it with a reason (1 to 1000 characters, not blank). ' +
      'The reviewer, their organization and the time are server-side.',
  });

export const DocumentReviewSchema = z
  .object({
    decision: DocumentReviewDecisionSchema,
    /** Why the version was rejected; null for an approval. */
    reason: z.string().min(1).max(REJECTION_REASON_MAX_LENGTH).nullable(),
    reviewedAt: z.iso.datetime(),
    reviewedBy: DocumentActorSchema,
  })
  .refine((review) => (review.decision === 'REJECTED') === (review.reason !== null), {
    path: ['reason'],
    message: 'A rejection has a reason; an approval has none',
  })
  .register(apiSchemaRegistry, {
    id: 'DocumentReview',
    description: "The buyer's decision on one exact file version. Recorded once and never changed.",
  });

export const DocumentVersionSchema = z
  .object({
    /** 1 for the first upload, then 2, 3, ... Uploads only: reviews do not number files. */
    number: z.int().min(1),
    /** The name the file was uploaded with, for display only. */
    fileName: z.string().min(1).max(DOCUMENT_FILE_NAME_MAX_LENGTH),
    mediaType: z.literal(DOCUMENT_MEDIA_TYPE),
    sizeBytes: z.int().min(1).max(MAX_DOCUMENT_BYTES),
    /** SHA-256 of the bytes, lowercase hex, computed by the server as it received them. */
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    uploadedAt: z.iso.datetime(),
    uploadedBy: DocumentActorSchema,
    /**
     * The buyer's decision on this file, or null: pending while it is the current version, never
     * reviewed if it was replaced first.
     */
    review: DocumentReviewSchema.nullable(),
  })
  .register(apiSchemaRegistry, {
    id: 'DocumentVersion',
    description:
      'One uploaded file, with the decision made on it. Its bytes, its metadata and its ' +
      'decision never change.',
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
    /**
     * Advances on every change: each upload and each review. Its entity tag, `"<version>"`, is
     * the `ETag` of the document and the `If-Match` of the next replacement or review.
     */
    version: z.int().min(1),
    /** The latest upload: the only one that can be reviewed. */
    currentVersion: DocumentVersionSchema,
    /** Every earlier upload, newest first, with the decisions made on them. */
    previousVersions: z.array(DocumentVersionSchema),
  })
  .refine(
    (document) =>
      document.previousVersions.every(
        (version, index) => version.number === document.currentVersion.number - index - 1,
      ) && document.currentVersion.number === document.previousVersions.length + 1,
    { message: 'Versions run from the current one down to 1 without gaps' },
  )
  .refine(
    (document) =>
      document.version ===
      document.currentVersion.number +
        [document.currentVersion, ...document.previousVersions].filter(({ review }) => review)
          .length,
    { path: ['version'], message: 'The version counts every upload and every review' },
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

/**
 * The entity tag of a document at `version` (the document's version, not a file version
 * number), as sent in `ETag` and `If-Match`.
 */
export const documentEntityTag = (version: number): string => `"${version}"`;

export type DocumentActor = z.infer<typeof DocumentActorSchema>;
export type DocumentReviewDecision = z.infer<typeof DocumentReviewDecisionSchema>;
export type ReviewDocumentVersionRequest = z.infer<typeof ReviewDocumentVersionRequestSchema>;
export type DocumentReview = z.infer<typeof DocumentReviewSchema>;
export type DocumentVersion = z.infer<typeof DocumentVersionSchema>;
export type ContractDocument = z.infer<typeof ContractDocumentSchema>;
export type DocumentListResponse = z.infer<typeof DocumentListResponseSchema>;
