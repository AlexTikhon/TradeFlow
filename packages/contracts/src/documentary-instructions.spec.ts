import { describe, expect, it } from 'vitest';
import {
  AcknowledgeRevisionRequestSchema,
  type DocumentaryInstruction,
  DocumentaryInstructionContentSchema,
  type DocumentaryInstructionRevision,
  DocumentaryInstructionSchema,
  instructionEntityTag,
  PARTY_DETAILS_MAX_LENGTH,
  REQUIRED_DOCUMENT_TYPES,
  RevisionNumberParamSchema,
} from './documentary-instructions.js';

const validContent = {
  consignee: 'To order of Banco Exemplo S.A.',
  notifyParty: 'Rhine Valley Crushers GmbH\nHafenstrasse 1, Duisburg',
  requirements: [
    { document: 'BILL_OF_LADING', originals: 3, copies: 3 },
    { document: 'PHYTOSANITARY_CERTIFICATE', originals: 1, copies: 0 },
  ],
};

const seller = { id: '01990000-0000-7000-8001-000000000001', name: 'Seller', countryCode: 'BR' };
const buyer = { id: '01990000-0000-7000-8001-000000000004', name: 'Buyer', countryCode: 'CH' };

const revision = (number: number): DocumentaryInstructionRevision => ({
  number,
  consignee: 'To order',
  notifyParty: null,
  requirements: [{ document: 'BILL_OF_LADING', originals: 3, copies: 0 }],
  createdAt: '2026-10-15T09:00:00.000Z',
  createdBy: { name: 'Claire Morel', organization: buyer },
  acknowledgement: null,
});

const instruction: DocumentaryInstruction = {
  id: '01990000-0000-7000-800a-000000000001',
  voyageId: '01990000-0000-7000-8006-000000000001',
  contract: {
    id: '01990000-0000-7000-8008-000000000101',
    position: 1,
    side: 'SELLER',
    seller,
    buyer,
  },
  version: 4,
  currentRevision: revision(3),
  previousRevisions: [revision(2), revision(1)],
};

describe('DocumentaryInstructionContentSchema', () => {
  it('accepts content with and without a notify party', () => {
    expect(DocumentaryInstructionContentSchema.parse(validContent)).toEqual(validContent);
    const { notifyParty: _notifyParty, ...withoutNotifyParty } = validContent;
    expect(DocumentaryInstructionContentSchema.parse(withoutNotifyParty)).toEqual(
      withoutNotifyParty,
    );
  });

  it('trims party details, refuses blank ones and bounds them', () => {
    expect(
      DocumentaryInstructionContentSchema.parse({ ...validContent, consignee: '  To order  ' })
        .consignee,
    ).toBe('To order');
    for (const consignee of ['', ' \n ']) {
      const result = DocumentaryInstructionContentSchema.safeParse({ ...validContent, consignee });
      expect(result.error?.issues.map((issue) => issue.message)).toEqual(['Enter the consignee']);
    }
    const blankNotify = DocumentaryInstructionContentSchema.safeParse({
      ...validContent,
      notifyParty: '  ',
    });
    expect(blankNotify.error?.issues.map((issue) => issue.path)).toEqual([['notifyParty']]);
    const long = 'x'.repeat(PARTY_DETAILS_MAX_LENGTH + 1);
    expect(
      DocumentaryInstructionContentSchema.safeParse({ ...validContent, consignee: long }).success,
    ).toBe(false);
    expect(
      DocumentaryInstructionContentSchema.safeParse({
        ...validContent,
        consignee: 'x'.repeat(PARTY_DETAILS_MAX_LENGTH),
      }).success,
    ).toBe(true);
  });

  it('requires one to eight requirements, each document once', () => {
    const empty = DocumentaryInstructionContentSchema.safeParse({
      ...validContent,
      requirements: [],
    });
    expect(empty.error?.issues.map((issue) => issue.message)).toEqual([
      'Require at least one document',
    ]);

    const all = REQUIRED_DOCUMENT_TYPES.map((document) => ({ document, originals: 1, copies: 0 }));
    expect(
      DocumentaryInstructionContentSchema.safeParse({ ...validContent, requirements: all }).success,
    ).toBe(true);
    const tooMany = DocumentaryInstructionContentSchema.safeParse({
      ...validContent,
      requirements: [...all, { document: 'BILL_OF_LADING', originals: 1, copies: 0 }],
    });
    expect(tooMany.success).toBe(false);

    const duplicate = DocumentaryInstructionContentSchema.safeParse({
      ...validContent,
      requirements: [
        { document: 'BILL_OF_LADING', originals: 3, copies: 0 },
        { document: 'BILL_OF_LADING', originals: 0, copies: 2 },
      ],
    });
    expect(duplicate.error?.issues).toEqual([
      expect.objectContaining({
        path: ['requirements', 1, 'document'],
        message: 'Each document can be required only once',
      }),
    ]);
  });

  it.each([
    ['no originals and no copies', { originals: 0, copies: 0 }, ['requirements', 0, 'originals']],
    ['a negative count', { originals: -1, copies: 2 }, ['requirements', 0, 'originals']],
    ['a fractional count', { originals: 1, copies: 1.5 }, ['requirements', 0, 'copies']],
    ['too many originals', { originals: 11, copies: 0 }, ['requirements', 0, 'originals']],
    ['a count as a string', { originals: '3', copies: 0 }, ['requirements', 0, 'originals']],
  ])('rejects %s', (_case, counts, path) => {
    const result = DocumentaryInstructionContentSchema.safeParse({
      ...validContent,
      requirements: [{ document: 'BILL_OF_LADING', ...counts }],
    });
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([path]);
  });

  it('rejects unknown documents and fields the server decides', () => {
    expect(
      DocumentaryInstructionContentSchema.safeParse({
        ...validContent,
        requirements: [{ document: 'SECRET_TERMS', originals: 1, copies: 0 }],
      }).success,
    ).toBe(false);
    for (const extra of [
      { revisionNumber: 7 },
      { version: 2 },
      { createdByUserId: buyer.id },
      { contractId: instruction.contract.id },
    ]) {
      expect(
        DocumentaryInstructionContentSchema.safeParse({ ...validContent, ...extra }).success,
      ).toBe(false);
    }
    expect(
      DocumentaryInstructionContentSchema.safeParse({
        ...validContent,
        requirements: [{ document: 'BILL_OF_LADING', originals: 1, copies: 0, price: '1' }],
      }).success,
    ).toBe(false);
  });
});

describe('DocumentaryInstructionSchema', () => {
  it('accepts an instruction whose revisions run down to 1', () => {
    expect(DocumentaryInstructionSchema.parse(instruction)).toEqual(instruction);
    expect(
      DocumentaryInstructionSchema.safeParse({
        ...instruction,
        version: 1,
        currentRevision: revision(1),
        previousRevisions: [],
      }).success,
    ).toBe(true);
  });

  it.each([
    ['a gap', [revision(1)]],
    ['the wrong order', [revision(1), revision(2)]],
    ['a repeated current revision', [revision(3), revision(2), revision(1)]],
  ])('rejects revisions with %s', (_case, previousRevisions) => {
    expect(
      DocumentaryInstructionSchema.safeParse({ ...instruction, previousRevisions }).success,
    ).toBe(false);
  });
});

describe('acknowledging a revision', () => {
  it('takes an empty body and a positive revision number in the path', () => {
    expect(AcknowledgeRevisionRequestSchema.safeParse({}).success).toBe(true);
    expect(
      AcknowledgeRevisionRequestSchema.safeParse({ acknowledgedAt: '2020-01-01T00:00:00Z' })
        .success,
    ).toBe(false);
    expect(RevisionNumberParamSchema.parse('12')).toBe(12);
    for (const raw of ['0', '-1', '01', '1.0', '1e0', ' 1', 'one', '', '1234567890']) {
      expect(RevisionNumberParamSchema.safeParse(raw).success).toBe(false);
    }
  });
});

describe('instructionEntityTag', () => {
  it('quotes the version, as a strong entity tag', () => {
    expect(instructionEntityTag(4)).toBe('"4"');
  });
});
