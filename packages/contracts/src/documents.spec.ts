import { describe, expect, it } from 'vitest';
import {
  type ContractDocument,
  ContractDocumentSchema,
  DocumentFileSchema,
  documentEntityTag,
  DocumentVersionNumberParamSchema,
  type DocumentVersion,
  DocumentVersionSchema,
  MAX_DOCUMENT_BYTES,
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
});

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
  currentVersion: version(3),
  previousVersions: [version(2), version(1)],
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
        currentVersion: version(1),
        previousVersions: [],
      }).success,
    ).toBe(true);
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

describe('DocumentVersionNumberParamSchema', () => {
  it('reads a positive decimal number', () => {
    expect(DocumentVersionNumberParamSchema.parse('12')).toBe(12);
  });

  it.each(['0', '-1', '01', '1.0', 'one', ''])('refuses %j', (value) => {
    expect(DocumentVersionNumberParamSchema.safeParse(value).success).toBe(false);
  });
});

describe('documentEntityTag', () => {
  it('is the strong entity tag of the current version number', () => {
    expect(documentEntityTag(3)).toBe('"3"');
  });
});
