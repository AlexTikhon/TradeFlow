import { describe, expect, it } from 'vitest';
import {
  type ContractDocument,
  ContractDocumentSchema,
  DocumentFileSchema,
  documentEntityTag,
  type DocumentReview,
  DocumentReviewSchema,
  DocumentVersionNumberParamSchema,
  type DocumentVersion,
  DocumentVersionSchema,
  MAX_DOCUMENT_BYTES,
  REJECTION_REASON_MAX_LENGTH,
  ReviewDocumentVersionRequestSchema,
} from './documents.js';

// This package is compiled without DOM or Node types; Node provides `File` at runtime.
declare const File: new (
  parts: Uint8Array[],
  name: string,
  options: { type: string },
) => { name: string; size: number; type: string };

const seller = { id: '01990000-0000-7000-8001-000000000001', name: 'Seller', countryCode: 'BR' };
const buyer = { id: '01990000-0000-7000-8001-000000000004', name: 'Buyer', countryCode: 'CH' };

const version = (number: number): DocumentVersion => ({
  number,
  fileName: `bill-of-lading-v${number}.pdf`,
  mediaType: 'application/pdf',
  sizeBytes: 48_213,
  sha256: 'a'.repeat(64),
  uploadedAt: '2026-10-16T09:00:00.000Z',
  uploadedBy: { name: 'Ana Souza', organization: seller },
  review: null,
});

const rejection: DocumentReview = {
  decision: 'REJECTED',
  reason: 'The consignee does not match the instructions.',
  reviewedAt: '2026-10-16T10:00:00.000Z',
  reviewedBy: { name: 'Claire Morel', organization: buyer },
};

const document: ContractDocument = {
  id: '01990000-0000-7000-800b-000000000001',
  voyageId: '01990000-0000-7000-8006-000000000001',
  contract: {
    id: '01990000-0000-7000-8008-000000000101',
    position: 1,
    side: 'BUYER',
    seller,
    buyer,
  },
  revisionNumber: 1,
  documentType: 'BILL_OF_LADING',
  // Three uploads and one review: version 2 was rejected, version 3 is pending.
  version: 4,
  currentVersion: version(3),
  previousVersions: [{ ...version(2), review: rejection }, version(1)],
};

const pdf = (size: number, type = 'application/pdf') =>
  new File([new Uint8Array(size)], 'document.pdf', { type });

describe('DocumentFileSchema', () => {
  it('accepts a PDF up to the limit', () => {
    expect(DocumentFileSchema.safeParse(pdf(1)).success).toBe(true);
    expect(DocumentFileSchema.safeParse(pdf(MAX_DOCUMENT_BYTES)).success).toBe(true);
  });

  it.each<[string, ReturnType<typeof pdf>, string]>([
    ['an empty file', pdf(0), 'The file is empty'],
    ['a file one byte over 10 MiB', pdf(MAX_DOCUMENT_BYTES + 1), 'The file is larger than 10 MiB'],
    ['a file of another type', pdf(10, 'image/png'), 'Choose a PDF file'],
    ['a file of no known type', pdf(10, ''), 'Choose a PDF file'],
  ])('refuses %s', (_case, file, message) => {
    const result = DocumentFileSchema.safeParse(file);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message)).toEqual([message]);
  });
});

describe('DocumentVersionSchema', () => {
  it.each<[string, Partial<DocumentVersion>]>([
    ['an uppercase checksum', { sha256: 'A'.repeat(64) }],
    ['a short checksum', { sha256: 'a'.repeat(63) }],
    ['another media type', { mediaType: 'image/png' as 'application/pdf' }],
    ['an empty file', { sizeBytes: 0 }],
    ['a file over the limit', { sizeBytes: MAX_DOCUMENT_BYTES + 1 }],
    ['an empty file name', { fileName: '' }],
  ])('refuses %s', (_case, change) => {
    expect(DocumentVersionSchema.safeParse({ ...version(1), ...change }).success).toBe(false);
  });
});

describe('ContractDocumentSchema', () => {
  it('accepts versions from the current one down to 1', () => {
    expect(ContractDocumentSchema.parse(document)).toEqual(document);
    expect(
      ContractDocumentSchema.safeParse({
        ...document,
        version: 1,
        currentVersion: version(1),
        previousVersions: [],
      }).success,
    ).toBe(true);
  });

  it('counts every upload and every review in the version', () => {
    const approved: DocumentVersion = {
      ...version(3),
      review: { ...rejection, decision: 'APPROVED', reason: null },
    };
    expect(
      ContractDocumentSchema.safeParse({ ...document, version: 5, currentVersion: approved })
        .success,
    ).toBe(true);
    for (const wrong of [3, 5]) {
      const result = ContractDocumentSchema.safeParse({ ...document, version: wrong });
      expect(result.error?.issues.map(({ path, message }) => [path, message])).toEqual([
        [['version'], 'The version counts every upload and every review'],
      ]);
    }
  });

  it.each<[string, Partial<ContractDocument>]>([
    ['a gap', { previousVersions: [version(1)] }],
    ['oldest first', { previousVersions: [version(1), version(2)] }],
    ['a missing first version', { previousVersions: [version(2)] }],
    ['a document type nobody requires', { documentType: 'PACKING_LIST' as 'BILL_OF_LADING' }],
  ])('refuses %s', (_case, change) => {
    expect(ContractDocumentSchema.safeParse({ ...document, ...change }).success).toBe(false);
  });
});

describe('ReviewDocumentVersionRequestSchema', () => {
  it('accepts an approval, and a rejection with its reason trimmed', () => {
    expect(ReviewDocumentVersionRequestSchema.parse({ decision: 'APPROVED' })).toEqual({
      decision: 'APPROVED',
    });
    expect(
      ReviewDocumentVersionRequestSchema.parse({ decision: 'REJECTED', reason: '  Wrong port. ' }),
    ).toEqual({ decision: 'REJECTED', reason: 'Wrong port.' });
    expect(
      ReviewDocumentVersionRequestSchema.safeParse({
        decision: 'REJECTED',
        reason: 'x'.repeat(REJECTION_REASON_MAX_LENGTH),
      }).success,
    ).toBe(true);
  });

  it.each<[string, unknown]>([
    ['a rejection without a reason', { decision: 'REJECTED' }],
    ['a blank reason', { decision: 'REJECTED', reason: ' \n\t ' }],
    ['a reason over 1000 characters', { decision: 'REJECTED', reason: 'x'.repeat(1001) }],
    ['an approval with a reason', { decision: 'APPROVED', reason: 'Fine.' }],
    ['another decision', { decision: 'PENDING' }],
    ['a reviewer named by the client', { decision: 'APPROVED', reviewedBy: 'someone' }],
    ['a time chosen by the client', { decision: 'APPROVED', reviewedAt: '2026-10-16T10:00:00Z' }],
    ['no decision', {}],
  ])('refuses %s', (_case, body) => {
    expect(ReviewDocumentVersionRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe('DocumentReviewSchema', () => {
  it('pairs a rejection with a reason, and an approval with none', () => {
    expect(DocumentReviewSchema.safeParse(rejection).success).toBe(true);
    expect(
      DocumentReviewSchema.safeParse({ ...rejection, decision: 'APPROVED', reason: null }).success,
    ).toBe(true);
    expect(DocumentReviewSchema.safeParse({ ...rejection, reason: null }).success).toBe(false);
    expect(DocumentReviewSchema.safeParse({ ...rejection, decision: 'APPROVED' }).success).toBe(
      false,
    );
  });
});

describe('DocumentVersionNumberParamSchema', () => {
  it('reads a positive decimal number', () => {
    expect(DocumentVersionNumberParamSchema.parse('12')).toBe(12);
  });

  it.each(['0', '-1', '01', '1.0', 'one', ''])('refuses %j', (value) => {
    expect(DocumentVersionNumberParamSchema.safeParse(value).success).toBe(false);
  });
});

describe('documentEntityTag', () => {
  it('is the strong entity tag of the document version', () => {
    expect(documentEntityTag(4)).toBe('"4"');
  });
});
