import type { ActionItem } from '@tradeflow/contracts';
import { describe, expect, it } from 'vitest';
import {
  actionItemPage,
  decodeActionItemCursor,
  encodeActionItemCursor,
  pageActionItems,
  type ActionItemPageRequest,
} from './action-item-pages.js';
import { type ContractFacts, type NoticeFacts, positionOf } from './action-items.js';

const at = (iso: string) => new Date(iso);
const NOW = at('2026-10-18T12:00:00.000Z');

const seller = { id: '01990000-0000-7000-8001-000000000001', name: 'Cerrado', countryCode: 'BR' };
const buyer = { id: '01990000-0000-7000-8001-000000000002', name: 'Lacustra', countryCode: 'CH' };
const voyage = { id: '01990000-0000-7000-8006-000000000001', reference: 'TF-2026-0001' };
const CONTRACT_ID = '01990000-0000-7000-8007-000000000001';
const INSTRUCTION_ID = '01990000-0000-7000-8012-000000000001';

const noticeId = (n: number) => `01990000-0000-7000-8009-${String(n).padStart(12, '0')}`;
const documentId = (n: number) => `01990000-0000-7000-8011-${String(n).padStart(12, '0')}`;

/** Notice n is due on day 10 + n of October; notices 1 to 7 are overdue at NOW. */
const notice = (n: number, overrides: Partial<NoticeFacts> = {}): NoticeFacts => ({
  id: noticeId(n),
  status: 'ISSUED',
  issuedAt: at('2026-10-01T00:00:00.000Z'),
  acknowledgementDueAt: at(`2026-10-${10 + n}T00:00:00.000Z`),
  ...overrides,
});

/** A document of revision 1 whose single file, uploaded on day n, awaits the buyer's decision. */
const pendingDocument = (n: number) => ({
  id: documentId(n),
  revisionNumber: 1,
  documentType: 'BILL_OF_LADING' as const,
  currentVersionNumber: 1,
  versions: [{ number: 1, uploadedAt: at(`2026-10-0${n}T00:00:00.000Z`), review: null }],
});

const contract = (
  notices: readonly NoticeFacts[],
  documentNumbers: readonly number[] = [],
): ContractFacts => ({
  id: CONTRACT_ID,
  position: 1,
  voyage,
  seller,
  buyer,
  notices,
  instruction: {
    id: INSTRUCTION_ID,
    currentRevisionNumber: 1,
    revisions: [{ number: 1, createdAt: at('2026-10-01T00:00:00.000Z'), acknowledgedAt: null }],
  },
  documents: documentNumbers.map(pendingDocument),
});

const page = (facts: ContractFacts, request: ActionItemPageRequest, now = NOW) =>
  actionItemPage([facts], buyer.id, request, now);

/** Every page in turn, re-projecting `factsFor(pageIndex)` for each, as the endpoint will. */
function walk(
  factsFor: (pageIndex: number) => ContractFacts,
  request: Omit<ActionItemPageRequest, 'after'>,
): ActionItem[][] {
  const pages: ActionItem[][] = [];
  let cursor: string | null = null;
  do {
    const after: ReturnType<typeof decodeActionItemCursor> =
      cursor === null ? null : decodeActionItemCursor(cursor);
    const result = page(factsFor(pages.length), { ...request, after: after ?? undefined });
    pages.push(result.items);
    cursor = result.nextCursor;
  } while (cursor !== null && pages.length < 100);
  return pages;
}

const keys = (items: readonly ActionItem[]) => items.map(({ key }) => key);

describe('actionItemPage', () => {
  const facts = contract(
    [1, 2, 3, 4, 5].map((n) => notice(n)),
    [1, 2, 3],
  );

  it('serves a bounded page in order, with the time it was built and a cursor', () => {
    const result = page(facts, { limit: 3 });
    expect(keys(result.items)).toEqual([1, 2, 3].map((n) => `ACKNOWLEDGE_NOTICE:${noticeId(n)}`));
    expect(result.generatedAt).toBe(NOW.toISOString());
    expect(result.nextCursor).not.toBeNull();
  });

  it('serves every action exactly once across pages, the last page without a cursor', () => {
    const pages = walk(() => facts, { limit: 3 });
    expect(pages.map((items) => items.length)).toEqual([3, 3, 2]);
    expect(pages.flat()).toEqual(page(facts, { limit: 50 }).items);
  });

  it('gives no cursor when the page holds exactly what remains', () => {
    expect(page(facts, { limit: 8 }).nextCursor).toBeNull();
    expect(page(facts, { limit: 7 }).nextCursor).not.toBeNull();
  });

  it('serves an empty first page for an empty queue', () => {
    expect(page(contract([]), { limit: 20, type: 'REVIEW_DOCUMENT' })).toEqual({
      items: [],
      generatedAt: NOW.toISOString(),
      nextCursor: null,
    });
  });

  it('filters by type before cutting the page', () => {
    const result = page(facts, { type: 'REVIEW_DOCUMENT', limit: 2 });
    expect(keys(result.items)).toEqual([1, 2].map((n) => `REVIEW_DOCUMENT:${documentId(n)}:1`));
    const rest = page(facts, {
      type: 'REVIEW_DOCUMENT',
      limit: 2,
      after: decodeActionItemCursor(result.nextCursor ?? '') ?? undefined,
    });
    expect(keys(rest.items)).toEqual([`REVIEW_DOCUMENT:${documentId(3)}:1`]);
    expect(rest.nextCursor).toBeNull();
  });

  it('filters overdue notices as of the page’s clock, deadline exclusive', () => {
    const overdueAt = (now: Date) => keys(page(facts, { overdue: true, limit: 50 }, now).items);
    expect(overdueAt(at('2026-10-13T00:00:00.000Z'))).toEqual(
      [1, 2].map((n) => `ACKNOWLEDGE_NOTICE:${noticeId(n)}`),
    );
    expect(overdueAt(at('2026-10-13T00:00:00.001Z'))).toHaveLength(3);
  });

  it('finds nothing overdue among actions without a deadline', () => {
    expect(page(facts, { type: 'REVIEW_DOCUMENT', overdue: true, limit: 50 }).items).toEqual([]);
  });

  it('sorts items handed over in any order', () => {
    const items = page(facts, { limit: 50 }).items;
    expect(pageActionItems([...items].reverse(), { limit: 50 }, NOW).items).toEqual(items);
  });
});

describe('actionItemPage: records that change between pages', () => {
  const notices = [1, 2, 3, 4, 5, 6].map((n) => notice(n));

  it('drops an action answered after its page was served, and serves no other twice', () => {
    const pages = walk(
      (pageIndex) =>
        contract(
          pageIndex === 0
            ? notices
            : notices.map((n, i) => (i === 0 ? { ...n, status: 'ACKNOWLEDGED' } : n)),
        ),
      { limit: 2 },
    );
    expect(pages.flat().map(({ key }) => key)).toEqual(
      notices.map(({ id }) => `ACKNOWLEDGE_NOTICE:${id}`),
    );
  });

  it('never serves an action answered before its page was reached', () => {
    const pages = walk(
      (pageIndex) =>
        contract(
          pageIndex === 0
            ? notices
            : notices.map((n, i) => (i === 3 ? { ...n, status: 'ACKNOWLEDGED' } : n)),
        ),
      { limit: 2 },
    );
    expect(pages.flat().map(({ key }) => key)).not.toContain(`ACKNOWLEDGE_NOTICE:${noticeId(4)}`);
    expect(pages.flat()).toHaveLength(5);
  });

  it('misses a new action ordered before the cursor, and serves one ordered after it', () => {
    const early = notice(10, { acknowledgementDueAt: at('2026-10-10T00:00:00.000Z') });
    const late = notice(11, { acknowledgementDueAt: at('2026-10-30T00:00:00.000Z') });
    const pages = walk(
      (pageIndex) => contract(pageIndex === 0 ? notices : [...notices, early, late]),
      {
        limit: 2,
      },
    );
    const served = pages.flat().map(({ key }) => key);
    expect(served).not.toContain(`ACKNOWLEDGE_NOTICE:${early.id}`);
    expect(served.at(-1)).toBe(`ACKNOWLEDGE_NOTICE:${late.id}`);
  });

  it('keeps an action in place when it becomes overdue between pages', () => {
    // Notices 5 and 6 are due 15 and 16 Oct; the clock passes both between the two pages.
    const first = page(contract(notices), { limit: 3 }, at('2026-10-15T00:00:00.000Z'));
    const second = page(
      contract(notices),
      { limit: 3, after: decodeActionItemCursor(first.nextCursor ?? '') ?? undefined },
      at('2026-10-17T00:00:00.000Z'),
    );
    expect(keys([...first.items, ...second.items])).toEqual(
      notices.map(({ id }) => `ACKNOWLEDGE_NOTICE:${id}`),
    );
    const overdue = (items: readonly ActionItem[]) =>
      items.map((item) => item.type === 'ACKNOWLEDGE_NOTICE' && item.overdue);
    const atFirstPage = page(contract(notices), { limit: 6 }, at('2026-10-15T00:00:00.000Z'));
    expect(overdue(atFirstPage.items)).toEqual([true, true, true, true, false, false]);
    expect(overdue(second.items)).toEqual([true, true, true]);
  });
});

describe('action item cursors', () => {
  const position = {
    dated: false,
    at: at('2026-10-11T08:00:00.000Z'),
    key: `REVIEW_DOCUMENT:${documentId(1)}:1`,
  };

  it('round-trips a position as URL-safe text', () => {
    const cursor = encodeActionItemCursor(position);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeActionItemCursor(cursor)).toEqual(position);
    expect(decodeActionItemCursor(encodeActionItemCursor({ ...position, dated: true }))).toEqual({
      ...position,
      dated: true,
    });
  });

  it('is the position of the last item served', () => {
    const facts = contract([1, 2, 3].map((n) => notice(n)));
    const result = page(facts, { limit: 2 });
    const last = result.items.at(-1);
    expect(last && decodeActionItemCursor(result.nextCursor ?? '')).toEqual(
      last && positionOf(last),
    );
  });

  it.each([
    ['not base64url JSON', 'not-a-cursor'],
    ['an empty string', ''],
    [
      'a timeline cursor',
      Buffer.from(JSON.stringify(['2026-10-11T08:00:00.000Z', documentId(1)])).toString(
        'base64url',
      ),
    ],
    [
      'a tier that is not 0 or 1',
      Buffer.from(JSON.stringify([2, '2026-10-11T08:00:00.000Z', 'k'])).toString('base64url'),
    ],
    [
      'a time that is not an instant',
      Buffer.from(JSON.stringify([0, 'yesterday', 'k'])).toString('base64url'),
    ],
    [
      'an empty key',
      Buffer.from(JSON.stringify([0, '2026-10-11T08:00:00.000Z', ''])).toString('base64url'),
    ],
    [
      'an oversized key',
      Buffer.from(JSON.stringify([0, '2026-10-11T08:00:00.000Z', 'k'.repeat(101)])).toString(
        'base64url',
      ),
    ],
  ])('rejects %s', (_label, cursor) => {
    expect(decodeActionItemCursor(cursor)).toBeNull();
  });

  it('fits the contract’s cursor bound for the longest key', () => {
    const cursor = encodeActionItemCursor({
      dated: false,
      at: position.at,
      key: `REPLACE_REJECTED_DOCUMENT:${documentId(1)}:999999999`,
    });
    expect(cursor.length).toBeLessThanOrEqual(300);
  });
});
