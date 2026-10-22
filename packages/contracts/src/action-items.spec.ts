import { describe, expect, it } from 'vitest';
import {
  ACTION_ITEMS_MAX_PAGE_SIZE,
  type ActionItem,
  ActionItemPageSchema,
  ActionItemSchema,
  ActionItemsQuerySchema,
} from './action-items.js';

const VOYAGE_ID = '01990000-0000-7000-8006-000000000001';
const CONTRACT_ID = '01990000-0000-7000-8007-000000000001';
const DOCUMENT_ID = '01990000-0000-7000-8011-000000000001';

const seller = { id: '01990000-0000-7000-8001-000000000001', name: 'Seller', countryCode: 'BR' };

const base = {
  voyage: { id: VOYAGE_ID, reference: 'TF-2026-0001' },
  contract: { id: CONTRACT_ID, position: 1 },
  counterparty: seller,
};

const noticeItem: ActionItem = {
  ...base,
  key: 'ACKNOWLEDGE_NOTICE:01990000-0000-7000-8009-000000000001',
  type: 'ACKNOWLEDGE_NOTICE',
  issuedAt: '2026-10-15T09:00:00.000Z',
  acknowledgementDueAt: '2026-10-20T12:00:00.000Z',
  overdue: false,
  target: {
    kind: 'NOTICE',
    voyageId: VOYAGE_ID,
    contractId: CONTRACT_ID,
    noticeId: '01990000-0000-7000-8009-000000000001',
  },
};

const documentTarget = {
  kind: 'DOCUMENT_VERSION',
  voyageId: VOYAGE_ID,
  contractId: CONTRACT_ID,
  revisionNumber: 2,
  documentType: 'BILL_OF_LADING',
  documentId: DOCUMENT_ID,
  versionNumber: 3,
} as const;

const rejectedItem: ActionItem = {
  ...base,
  key: `REPLACE_REJECTED_DOCUMENT:${DOCUMENT_ID}:3`,
  type: 'REPLACE_REJECTED_DOCUMENT',
  uploadedAt: '2026-10-16T09:00:00.000Z',
  rejectedAt: '2026-10-17T09:00:00.000Z',
  rejectionReason: 'Consignee does not match revision 2.',
  target: documentTarget,
};

describe('ActionItemSchema', () => {
  it('accepts each kind of action with its own target', () => {
    expect(ActionItemSchema.parse(noticeItem)).toEqual(noticeItem);
    expect(ActionItemSchema.parse(rejectedItem)).toEqual(rejectedItem);
    const review = {
      ...base,
      key: `REVIEW_DOCUMENT:${DOCUMENT_ID}:3`,
      type: 'REVIEW_DOCUMENT',
      uploadedAt: '2026-10-16T09:00:00.000Z',
      target: documentTarget,
    };
    expect(ActionItemSchema.parse(review)).toEqual(review);
    const instructions = {
      ...base,
      key: 'ACKNOWLEDGE_INSTRUCTIONS:01990000-0000-7000-8012-000000000001:2',
      type: 'ACKNOWLEDGE_INSTRUCTIONS',
      revisionCreatedAt: '2026-10-16T09:00:00.000Z',
      target: {
        kind: 'INSTRUCTION_REVISION',
        voyageId: VOYAGE_ID,
        contractId: CONTRACT_ID,
        instructionId: '01990000-0000-7000-8012-000000000001',
        revisionNumber: 2,
      },
    };
    expect(ActionItemSchema.parse(instructions)).toEqual(instructions);
  });

  it('refuses a target of another kind than the action’s', () => {
    expect(ActionItemSchema.safeParse({ ...noticeItem, target: documentTarget }).success).toBe(
      false,
    );
    expect(ActionItemSchema.safeParse({ ...rejectedItem, target: noticeItem.target }).success).toBe(
      false,
    );
  });

  it('refuses a target on another voyage or contract than the item’s', () => {
    const otherId = '01990000-0000-7000-8099-000000000001';
    expect(
      ActionItemSchema.safeParse({
        ...rejectedItem,
        target: { ...documentTarget, voyageId: otherId },
      }).success,
    ).toBe(false);
    expect(
      ActionItemSchema.safeParse({
        ...rejectedItem,
        target: { ...documentTarget, contractId: otherId },
      }).success,
    ).toBe(false);
  });

  it('carries a deadline only on notices', () => {
    const { rejectionReason: _reason, rejectedAt: _at, ...review } = rejectedItem;
    const parsed = ActionItemSchema.parse({
      ...review,
      type: 'REVIEW_DOCUMENT',
      acknowledgementDueAt: '2026-10-20T12:00:00.000Z',
      overdue: true,
    });
    expect(parsed).not.toHaveProperty('acknowledgementDueAt');
    expect(parsed).not.toHaveProperty('overdue');
    const { acknowledgementDueAt: _due, ...withoutDeadline } = noticeItem;
    expect(ActionItemSchema.safeParse(withoutDeadline).success).toBe(false);
  });

  it('carries a rejection reason only on a rejected document to replace', () => {
    const { rejectionReason: _reason, ...withoutReason } = rejectedItem;
    expect(ActionItemSchema.safeParse(withoutReason).success).toBe(false);
    expect(ActionItemSchema.safeParse({ ...rejectedItem, rejectionReason: '' }).success).toBe(
      false,
    );
    const parsed = ActionItemSchema.parse({
      ...rejectedItem,
      type: 'REVIEW_DOCUMENT',
    });
    expect(parsed).not.toHaveProperty('rejectionReason');
    expect(parsed).not.toHaveProperty('rejectedAt');
  });

  it('drops anything beyond the action’s references', () => {
    const parsed = ActionItemSchema.parse({
      ...noticeItem,
      message: 'Vessel sailed Santos on 14 Oct.',
      contract: { ...base.contract, side: 'BUYER', seller },
      voyage: { ...base.voyage, vessel: { name: 'MV Example' } },
    });
    expect(parsed).not.toHaveProperty('message');
    expect(parsed.contract).toEqual(base.contract);
    expect(parsed.voyage).toEqual(base.voyage);
  });

  it('rejects a type it does not know, and an unbounded key', () => {
    expect(ActionItemSchema.safeParse({ ...noticeItem, type: 'SIGN_CONTRACT' }).success).toBe(
      false,
    );
    expect(ActionItemSchema.safeParse({ ...noticeItem, key: '' }).success).toBe(false);
    expect(ActionItemSchema.safeParse({ ...noticeItem, key: 'k'.repeat(101) }).success).toBe(false);
  });
});

describe('ActionItemPageSchema', () => {
  const page = { items: [noticeItem], generatedAt: '2026-10-18T00:00:00.000Z', nextCursor: null };

  it('accepts a last page and a page with a cursor', () => {
    expect(ActionItemPageSchema.parse(page)).toEqual(page);
    expect(ActionItemPageSchema.safeParse({ ...page, nextCursor: 'abc' }).success).toBe(true);
  });

  it('requires generatedAt and a nullable, present nextCursor', () => {
    const { generatedAt: _at, ...withoutTime } = page;
    expect(ActionItemPageSchema.safeParse(withoutTime).success).toBe(false);
    const { nextCursor: _cursor, ...withoutCursor } = page;
    expect(ActionItemPageSchema.safeParse(withoutCursor).success).toBe(false);
    expect(ActionItemPageSchema.safeParse({ ...page, nextCursor: '' }).success).toBe(false);
  });

  it('carries no total', () => {
    expect(ActionItemPageSchema.parse({ ...page, total: 1 })).not.toHaveProperty('total');
  });

  it('holds at most one full page', () => {
    const items = Array.from({ length: ACTION_ITEMS_MAX_PAGE_SIZE + 1 }, () => noticeItem);
    expect(ActionItemPageSchema.safeParse({ ...page, items }).success).toBe(false);
  });
});

describe('ActionItemsQuerySchema', () => {
  it('accepts an empty query', () => {
    expect(ActionItemsQuerySchema.parse({})).toEqual({});
  });

  it('reads every parameter', () => {
    expect(
      ActionItemsQuerySchema.parse({
        type: 'ACKNOWLEDGE_NOTICE',
        overdue: 'true',
        limit: '50',
        cursor: 'abc_-1',
      }),
    ).toEqual({ type: 'ACKNOWLEDGE_NOTICE', overdue: true, limit: 50, cursor: 'abc_-1' });
  });

  it.each(['acknowledge_notice', 'SIGN_CONTRACT', ''])('rejects type %j', (type) => {
    expect(ActionItemsQuerySchema.safeParse({ type }).success).toBe(false);
  });

  it.each(['false', 'TRUE', '1', ''])('rejects overdue %j', (overdue) => {
    expect(ActionItemsQuerySchema.safeParse({ overdue }).success).toBe(false);
  });

  it.each(['0', '51', '-1', '1.5', '01', 'ten', ''])('rejects limit %j', (limit) => {
    expect(ActionItemsQuerySchema.safeParse({ limit }).success).toBe(false);
  });

  it.each(['', 'a+b', 'a/b', 'a=', 'x'.repeat(301)])('rejects cursor %j', (cursor) => {
    expect(ActionItemsQuerySchema.safeParse({ cursor }).success).toBe(false);
  });

  it('rejects a repeated parameter', () => {
    expect(
      ActionItemsQuerySchema.safeParse({ type: ['ACKNOWLEDGE_NOTICE', 'REVIEW_DOCUMENT'] }).success,
    ).toBe(false);
    expect(ActionItemsQuerySchema.safeParse({ cursor: ['a', 'b'] }).success).toBe(false);
  });
});
