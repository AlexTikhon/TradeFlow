import { describe, expect, it } from 'vitest';
import { toContractFacts } from './contract-facts.js';

const seller = { id: '01990000-0000-7000-8000-000000000001', name: 'Seller', countryCode: 'BR' };
const buyer = { id: '01990000-0000-7000-8000-000000000002', name: 'Buyer', countryCode: 'NL' };
const voyage = { id: '01990000-0000-7000-8000-000000000010', reference: 'TF-2026-0001' };
const C1 = '01990000-0000-7000-8000-000000000101';
const C2 = '01990000-0000-7000-8000-000000000102';
const ELSEWHERE = '01990000-0000-7000-8000-000000000199';
const at = (iso: string) => new Date(iso);

const first = { id: C1, position: 1, voyage, seller, buyer };
const contracts = [first, { id: C2, position: 2, voyage, seller: buyer, buyer: seller }];

describe('toContractFacts', () => {
  it('gives each contract its own facts, with exactly the current revision and latest file', () => {
    const facts = toContractFacts({
      contracts,
      notices: [
        {
          id: 'n1',
          contractId: C1,
          issuedAt: at('2026-10-01T00:00:00Z'),
          acknowledgementDueAt: at('2026-10-02T00:00:00Z'),
        },
      ],
      revisions: [
        {
          instructionId: 'i1',
          contractId: C1,
          revisionNumber: 3,
          createdAt: at('2026-10-03T00:00:00Z'),
          acknowledgedAt: null,
        },
      ],
      documents: [
        {
          documentId: 'd1',
          contractId: C1,
          revisionNumber: 3,
          documentType: 'BILL_OF_LADING',
          versionNumber: 2,
          uploadedAt: at('2026-10-04T00:00:00Z'),
          review: { decision: 'REJECTED', reason: 'Wrong', reviewedAt: at('2026-10-05T00:00:00Z') },
        },
      ],
    });

    expect(facts).toEqual([
      {
        id: C1,
        position: 1,
        voyage,
        seller,
        buyer,
        notices: [
          {
            id: 'n1',
            status: 'ISSUED',
            issuedAt: at('2026-10-01T00:00:00Z'),
            acknowledgementDueAt: at('2026-10-02T00:00:00Z'),
          },
        ],
        instruction: {
          id: 'i1',
          currentRevisionNumber: 3,
          revisions: [{ number: 3, createdAt: at('2026-10-03T00:00:00Z'), acknowledgedAt: null }],
        },
        documents: [
          {
            id: 'd1',
            revisionNumber: 3,
            documentType: 'BILL_OF_LADING',
            currentVersionNumber: 2,
            versions: [
              {
                number: 2,
                uploadedAt: at('2026-10-04T00:00:00Z'),
                review: {
                  decision: 'REJECTED',
                  reason: 'Wrong',
                  reviewedAt: at('2026-10-05T00:00:00Z'),
                },
              },
            ],
          },
        ],
      },
      {
        id: C2,
        position: 2,
        voyage,
        seller: buyer,
        buyer: seller,
        notices: [],
        instruction: null,
        documents: [],
      },
    ]);
  });

  it('ignores facts under contracts outside the scope', () => {
    const facts = toContractFacts({
      contracts: [first],
      notices: [
        {
          id: 'n9',
          contractId: ELSEWHERE,
          issuedAt: at('2026-10-01T00:00:00Z'),
          acknowledgementDueAt: at('2026-10-02T00:00:00Z'),
        },
      ],
      revisions: [
        {
          instructionId: 'i9',
          contractId: ELSEWHERE,
          revisionNumber: 1,
          createdAt: at('2026-10-03T00:00:00Z'),
          acknowledgedAt: null,
        },
      ],
      documents: [],
    });

    expect(facts).toEqual([{ ...first, notices: [], instruction: null, documents: [] }]);
  });
});
