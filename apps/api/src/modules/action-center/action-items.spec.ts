import type { ActionItem } from '@tradeflow/contracts';
import { describe, expect, it } from 'vitest';
import {
  type ContractFacts,
  type DocumentFacts,
  type DocumentVersionFacts,
  type InstructionFacts,
  type NoticeFacts,
  projectActionItems,
} from './action-items.js';

const at = (iso: string) => new Date(iso);
const NOW = at('2026-10-18T12:00:00.000Z');

const exporter = { id: '01990000-0000-7000-8001-000000000001', name: 'Cerrado', countryCode: 'BR' };
const trader = { id: '01990000-0000-7000-8001-000000000002', name: 'Lacustra', countryCode: 'CH' };
const buyer = {
  id: '01990000-0000-7000-8001-000000000003',
  name: 'Rhine Valley',
  countryCode: 'DE',
};
const outsider = {
  id: '01990000-0000-7000-8001-000000000009',
  name: 'Surveyor',
  countryCode: 'NL',
};

const voyage = { id: '01990000-0000-7000-8006-000000000001', reference: 'TF-2026-0001' };

const ids = {
  contract1: '01990000-0000-7000-8007-000000000001',
  contract2: '01990000-0000-7000-8007-000000000002',
  notice1: '01990000-0000-7000-8009-000000000001',
  notice2: '01990000-0000-7000-8009-000000000002',
  instruction: '01990000-0000-7000-8012-000000000001',
  instruction2: '01990000-0000-7000-8012-000000000002',
  document1: '01990000-0000-7000-8011-000000000001',
  document2: '01990000-0000-7000-8011-000000000002',
};

const notice = (overrides: Partial<NoticeFacts> = {}): NoticeFacts => ({
  id: ids.notice1,
  status: 'ISSUED',
  issuedAt: at('2026-10-15T09:00:00.000Z'),
  acknowledgementDueAt: at('2026-10-20T09:00:00.000Z'),
  ...overrides,
});

/** Revision n was given on day n of October, at noon. */
const instruction = (
  currentRevisionNumber: number,
  acknowledged: readonly number[] = [],
): InstructionFacts => ({
  id: ids.instruction,
  currentRevisionNumber,
  revisions: Array.from({ length: currentRevisionNumber }, (_, index) => ({
    number: index + 1,
    createdAt: at(`2026-10-0${index + 1}T12:00:00.000Z`),
    acknowledgedAt: acknowledged.includes(index + 1) ? at('2026-10-09T12:00:00.000Z') : null,
  })),
});

const pending = (number: number): DocumentVersionFacts => ({
  number,
  uploadedAt: at(`2026-10-1${number}T08:00:00.000Z`),
  review: null,
});
const approved = (number: number): DocumentVersionFacts => ({
  ...pending(number),
  review: {
    decision: 'APPROVED',
    reason: null,
    reviewedAt: at(`2026-10-1${number}T10:00:00.000Z`),
  },
});
const rejected = (number: number, reason = 'Wrong consignee'): DocumentVersionFacts => ({
  ...pending(number),
  review: { decision: 'REJECTED', reason, reviewedAt: at(`2026-10-1${number}T10:00:00.000Z`) },
});

/** A document of `revisionNumber` whose versions are given oldest first. */
const document = (
  revisionNumber: number,
  versions: DocumentVersionFacts[],
  overrides: Partial<DocumentFacts> = {},
): DocumentFacts => ({
  id: ids.document1,
  revisionNumber,
  documentType: 'BILL_OF_LADING',
  currentVersionNumber: versions.length,
  versions,
  ...overrides,
});

/** Contract 1: the exporter sells to the trader. */
const contract = (overrides: Partial<ContractFacts> = {}): ContractFacts => ({
  id: ids.contract1,
  position: 1,
  voyage,
  seller: exporter,
  buyer: trader,
  notices: [],
  instruction: null,
  documents: [],
  ...overrides,
});

const types = (items: readonly ActionItem[]) => items.map(({ type }) => type);

describe('projectActionItems: who owes what', () => {
  const everything = contract({
    notices: [notice()],
    instruction: instruction(1),
    documents: [
      document(1, [pending(1)]),
      document(1, [rejected(1)], { id: ids.document2, documentType: 'COMMERCIAL_INVOICE' }),
    ],
  });

  it('asks the buyer to acknowledge notices and review documents', () => {
    expect(types(projectActionItems([everything], trader.id, NOW))).toEqual([
      'ACKNOWLEDGE_NOTICE',
      'REVIEW_DOCUMENT',
    ]);
  });

  it('asks the seller to acknowledge instructions and replace rejected documents', () => {
    expect(types(projectActionItems([everything], exporter.id, NOW))).toEqual([
      'ACKNOWLEDGE_INSTRUCTIONS',
      'REPLACE_REJECTED_DOCUMENT',
    ]);
  });

  it('asks nothing of an organization that is party to no contract, whatever the facts', () => {
    expect(projectActionItems([everything], outsider.id, NOW)).toEqual([]);
  });

  it('decides by the side of each contract: a trader buys under one and sells under the next', () => {
    const downstream = contract({
      id: ids.contract2,
      position: 2,
      seller: trader,
      buyer,
      notices: [notice({ id: ids.notice2 })],
      instruction: instruction(1),
    });
    const items = projectActionItems([everything, downstream], trader.id, NOW);
    expect(items.map(({ type, contract: { position } }) => [type, position])).toEqual([
      ['ACKNOWLEDGE_NOTICE', 1],
      ['ACKNOWLEDGE_INSTRUCTIONS', 2],
      ['REVIEW_DOCUMENT', 1],
    ]);
    // The downstream buyer owes the notice the trader sent it, not the trader.
    expect(types(projectActionItems([downstream], buyer.id, NOW))).toEqual(['ACKNOWLEDGE_NOTICE']);
  });

  it('names the other party to the contract as the counterparty', () => {
    const items = projectActionItems([everything], trader.id, NOW);
    expect(items.map(({ counterparty }) => counterparty)).toEqual([exporter, exporter]);
    expect(projectActionItems([everything], exporter.id, NOW)[0]?.counterparty).toEqual(trader);
  });

  it('serves only the minimal references, whatever else the facts carry', () => {
    const [item] = projectActionItems(
      [
        contract({
          voyage: { ...voyage, status: 'LOADING' } as typeof voyage,
          seller: { ...exporter, taxId: 'secret' } as typeof exporter,
          notices: [notice()],
        }),
      ],
      trader.id,
      NOW,
    );
    expect(item).toEqual({
      key: `ACKNOWLEDGE_NOTICE:${ids.notice1}`,
      type: 'ACKNOWLEDGE_NOTICE',
      voyage,
      contract: { id: ids.contract1, position: 1 },
      counterparty: exporter,
      issuedAt: '2026-10-15T09:00:00.000Z',
      acknowledgementDueAt: '2026-10-20T09:00:00.000Z',
      overdue: false,
      target: {
        kind: 'NOTICE',
        voyageId: voyage.id,
        contractId: ids.contract1,
        noticeId: ids.notice1,
      },
    });
  });
});

describe('projectActionItems: notices', () => {
  const due = at('2026-10-20T09:00:00.000Z');
  const project = (now: Date) =>
    projectActionItems(
      [contract({ notices: [notice({ acknowledgementDueAt: due })] })],
      trader.id,
      now,
    );

  it('is not overdue before or exactly at the deadline', () => {
    expect(project(at('2026-10-20T08:59:59.999Z'))).toMatchObject([{ overdue: false }]);
    expect(project(due)).toMatchObject([{ overdue: false }]);
  });

  it('is overdue from the first millisecond after the deadline', () => {
    expect(project(at('2026-10-20T09:00:00.001Z'))).toMatchObject([{ overdue: true }]);
  });

  it('asks nothing once acknowledged, on time or late', () => {
    const acknowledged = contract({ notices: [notice({ status: 'ACKNOWLEDGED' })] });
    expect(projectActionItems([acknowledged], trader.id, at('2027-01-01T00:00:00.000Z'))).toEqual(
      [],
    );
  });

  it('asks for each notice still issued, and only those', () => {
    const items = projectActionItems(
      [
        contract({
          notices: [notice({ status: 'ACKNOWLEDGED' }), notice({ id: ids.notice2 })],
        }),
      ],
      trader.id,
      NOW,
    );
    expect(items.map(({ key }) => key)).toEqual([`ACKNOWLEDGE_NOTICE:${ids.notice2}`]);
  });
});

describe('projectActionItems: instructions', () => {
  const sellerItems = (facts: Partial<ContractFacts>) =>
    projectActionItems([contract(facts)], exporter.id, NOW);

  it('asks nothing before the buyer gives instructions', () => {
    expect(sellerItems({ instruction: null })).toEqual([]);
  });

  it('asks the seller to acknowledge the current revision, by number and time', () => {
    expect(sellerItems({ instruction: instruction(2, [1]) })).toEqual([
      expect.objectContaining({
        key: `ACKNOWLEDGE_INSTRUCTIONS:${ids.instruction}:2`,
        type: 'ACKNOWLEDGE_INSTRUCTIONS',
        revisionCreatedAt: '2026-10-02T12:00:00.000Z',
        target: {
          kind: 'INSTRUCTION_REVISION',
          voyageId: voyage.id,
          contractId: ids.contract1,
          instructionId: ids.instruction,
          revisionNumber: 2,
        },
      }),
    ]);
  });

  it('asks nothing once the current revision is acknowledged, whatever earlier ones lack', () => {
    expect(sellerItems({ instruction: instruction(3, [3]) })).toEqual([]);
  });

  it('never asks the buyer to acknowledge its own instructions', () => {
    expect(projectActionItems([contract({ instruction: instruction(1) })], trader.id, NOW)).toEqual(
      [],
    );
  });

  it('needs only the current revision among the facts', () => {
    const onlyCurrent = instruction(3);
    expect(
      sellerItems({
        instruction: { ...onlyCurrent, revisions: onlyCurrent.revisions.slice(2) },
      }),
    ).toHaveLength(1);
  });

  it('refuses facts without the current revision as a data error', () => {
    const broken = { ...instruction(2), revisions: instruction(1).revisions };
    expect(() => sellerItems({ instruction: broken })).toThrow(/lacks its current revision 2/);
  });
});

describe('projectActionItems: documents', () => {
  const buyerItems = (facts: Partial<ContractFacts>) =>
    projectActionItems([contract(facts)], trader.id, NOW);
  // The seller's acknowledgement of the revision is no prerequisite for any document action.
  const sellerItems = (facts: Partial<ContractFacts>) =>
    projectActionItems([contract(facts)], exporter.id, NOW).filter(
      ({ type }) => type !== 'ACKNOWLEDGE_INSTRUCTIONS',
    );

  it('asks the buyer to review the latest file while it is pending', () => {
    expect(
      buyerItems({ instruction: instruction(1), documents: [document(1, [pending(1)])] }),
    ).toEqual([
      expect.objectContaining({
        key: `REVIEW_DOCUMENT:${ids.document1}:1`,
        type: 'REVIEW_DOCUMENT',
        uploadedAt: '2026-10-11T08:00:00.000Z',
        target: {
          kind: 'DOCUMENT_VERSION',
          voyageId: voyage.id,
          contractId: ids.contract1,
          revisionNumber: 1,
          documentType: 'BILL_OF_LADING',
          documentId: ids.document1,
          versionNumber: 1,
        },
      }),
    ]);
  });

  it('asks the seller to replace the latest file once rejected, with the reason', () => {
    const items = sellerItems({
      instruction: instruction(1),
      documents: [document(1, [rejected(1, 'Weight differs from the B/L')])],
    });
    expect(items).toEqual([
      expect.objectContaining({
        key: `REPLACE_REJECTED_DOCUMENT:${ids.document1}:1`,
        type: 'REPLACE_REJECTED_DOCUMENT',
        uploadedAt: '2026-10-11T08:00:00.000Z',
        rejectedAt: '2026-10-11T10:00:00.000Z',
        rejectionReason: 'Weight differs from the B/L',
        target: {
          kind: 'DOCUMENT_VERSION',
          voyageId: voyage.id,
          contractId: ids.contract1,
          revisionNumber: 1,
          documentType: 'BILL_OF_LADING',
          documentId: ids.document1,
          versionNumber: 1,
        },
      }),
    ]);
  });

  it('carries the rejection reason on nothing but a replacement', () => {
    const items = projectActionItems(
      [
        contract({
          notices: [notice()],
          instruction: instruction(1),
          documents: [document(1, [rejected(1), pending(2)])],
        }),
      ],
      trader.id,
      NOW,
    );
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item).not.toHaveProperty('rejectionReason');
    }
  });

  it('asks nothing of either side for an approved latest file', () => {
    const facts = { instruction: instruction(1, [1]), documents: [document(1, [approved(1)])] };
    expect(buyerItems(facts)).toEqual([]);
    expect(sellerItems(facts)).toEqual([]);
  });

  it('treats a rejected file replaced by a pending one as the replacement’s review only', () => {
    const facts = {
      instruction: instruction(1),
      documents: [document(1, [rejected(1), pending(2)])],
    };
    expect(buyerItems(facts).map(({ key }) => key)).toEqual([`REVIEW_DOCUMENT:${ids.document1}:2`]);
    expect(sellerItems(facts)).toEqual([]);
  });

  it('ignores decisions and pending files on earlier versions', () => {
    // v1 never reviewed (replaced first), v2 rejected, v3 approved.
    const facts = {
      instruction: instruction(1),
      documents: [document(1, [pending(1), rejected(2), approved(3)])],
    };
    expect(buyerItems(facts)).toEqual([]);
    expect(sellerItems(facts)).toEqual([]);
  });

  it('asks nothing about documents of a superseded revision', () => {
    const facts = {
      instruction: instruction(2),
      documents: [
        document(1, [pending(1)]),
        document(1, [rejected(1)], { id: ids.document2, documentType: 'COMMERCIAL_INVOICE' }),
      ],
    };
    expect(buyerItems(facts)).toEqual([]);
    expect(sellerItems(facts)).toEqual([]);
  });

  it('asks about the current revision’s documents beside a superseded one’s', () => {
    const facts = {
      instruction: instruction(2),
      documents: [document(1, [pending(1)]), document(2, [pending(1)], { id: ids.document2 })],
    };
    expect(buyerItems(facts).map(({ key }) => key)).toEqual([`REVIEW_DOCUMENT:${ids.document2}:1`]);
  });

  it('asks nothing about documents when the contract has no instruction', () => {
    expect(buyerItems({ instruction: null, documents: [document(1, [pending(1)])] })).toEqual([]);
  });

  it('needs only the latest version among the facts', () => {
    const latestOnly = document(1, [rejected(1), pending(2)]);
    expect(
      buyerItems({
        instruction: instruction(1),
        documents: [{ ...latestOnly, versions: latestOnly.versions.slice(1) }],
      }),
    ).toHaveLength(1);
  });

  it('refuses facts without the latest version, or a rejection without a reason', () => {
    const missing = { ...document(1, [pending(1)]), currentVersionNumber: 2 };
    expect(() => buyerItems({ instruction: instruction(1), documents: [missing] })).toThrow(
      /lacks its current version 2/,
    );
    const reasonless = document(1, [
      { ...pending(1), review: { decision: 'REJECTED', reason: null, reviewedAt: NOW } },
    ]);
    expect(() => sellerItems({ instruction: instruction(1), documents: [reasonless] })).toThrow(
      /has no reason/,
    );
  });
});

describe('projectActionItems: keys and order', () => {
  const facts = [
    contract({
      notices: [
        notice({ id: ids.notice2, acknowledgementDueAt: at('2026-10-25T00:00:00.000Z') }),
        notice({ acknowledgementDueAt: at('2026-10-17T00:00:00.000Z') }),
      ],
      instruction: instruction(1),
      documents: [
        document(1, [pending(1), pending(2)], { id: ids.document2 }),
        document(1, [pending(1)]),
      ],
    }),
  ];

  it('gives the same keys on every read, whatever the clock', () => {
    const keys = (now: Date) => projectActionItems(facts, trader.id, now).map(({ key }) => key);
    expect(keys(NOW)).toEqual(keys(at('2027-06-01T00:00:00.000Z')));
    expect(new Set(keys(NOW)).size).toBe(4);
  });

  it('gives a new key for a new file, and for a new revision', () => {
    const key = (contractFacts: ContractFacts, organizationId: string) =>
      projectActionItems([contractFacts], organizationId, NOW)[0]?.key;
    expect(
      key(
        contract({ instruction: instruction(1), documents: [document(1, [pending(1)])] }),
        trader.id,
      ),
    ).not.toBe(
      key(
        contract({
          instruction: instruction(1),
          documents: [document(1, [rejected(1), pending(2)])],
        }),
        trader.id,
      ),
    );
    expect(key(contract({ instruction: instruction(1) }), exporter.id)).not.toBe(
      key(contract({ instruction: instruction(2, [1]) }), exporter.id),
    );
  });

  it('puts deadlines first, earliest (overdue) first, then the longest waiting', () => {
    expect(projectActionItems(facts, trader.id, NOW).map(({ key }) => key)).toEqual([
      `ACKNOWLEDGE_NOTICE:${ids.notice1}`, // due 17 Oct: overdue
      `ACKNOWLEDGE_NOTICE:${ids.notice2}`, // due 25 Oct
      `REVIEW_DOCUMENT:${ids.document1}:1`, // uploaded 11 Oct
      `REVIEW_DOCUMENT:${ids.document2}:2`, // uploaded 12 Oct
    ]);
  });

  it('places a notice due far ahead before any action without a deadline', () => {
    const items = projectActionItems(
      [
        contract({
          seller: trader,
          buyer: exporter,
          notices: [notice({ acknowledgementDueAt: at('2030-01-01T00:00:00.000Z') })],
          instruction: instruction(1),
          documents: [document(1, [pending(1)])],
        }),
      ],
      exporter.id,
      NOW,
    );
    expect(types(items)).toEqual(['ACKNOWLEDGE_NOTICE', 'REVIEW_DOCUMENT']);
  });

  it('orders actions without a deadline by when they became due, across types', () => {
    // Revision 1 given 1 Oct; v1 of document 1 rejected 11 Oct 10:00; document 2 rejected 12 Oct.
    const items = projectActionItems(
      [
        contract({
          instruction: instruction(1),
          documents: [
            document(1, [pending(1), rejected(2)], { id: ids.document2 }),
            document(1, [rejected(1)]),
          ],
        }),
      ],
      exporter.id,
      NOW,
    );
    expect(items.map(({ key }) => key)).toEqual([
      `ACKNOWLEDGE_INSTRUCTIONS:${ids.instruction}:1`,
      `REPLACE_REJECTED_DOCUMENT:${ids.document1}:1`,
      `REPLACE_REJECTED_DOCUMENT:${ids.document2}:2`,
    ]);
  });

  it('breaks equal times by key, so input order never matters', () => {
    const sameTime = (id: string) =>
      notice({ id, acknowledgementDueAt: at('2026-10-20T00:00:00.000Z') });
    const forward = projectActionItems(
      [contract({ notices: [sameTime(ids.notice1), sameTime(ids.notice2)] })],
      trader.id,
      NOW,
    );
    const backward = projectActionItems(
      [contract({ notices: [sameTime(ids.notice2), sameTime(ids.notice1)] })],
      trader.id,
      NOW,
    );
    expect(forward).toEqual(backward);
    expect(forward.map(({ key }) => key)).toEqual([
      `ACKNOWLEDGE_NOTICE:${ids.notice1}`,
      `ACKNOWLEDGE_NOTICE:${ids.notice2}`,
    ]);
  });

  it('gives the same order for contracts listed in any order', () => {
    const downstream = contract({
      id: ids.contract2,
      position: 2,
      seller: trader,
      buyer,
      instruction: { ...instruction(1), id: ids.instruction2 },
    });
    expect(projectActionItems([...facts, downstream], trader.id, NOW)).toEqual(
      projectActionItems([downstream, ...facts], trader.id, NOW),
    );
  });
});
