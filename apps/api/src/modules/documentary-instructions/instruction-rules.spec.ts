import { describe, expect, it } from 'vitest';
import { sameContent, type StoredContent, toStoredContent } from './instruction-rules.js';

const content: StoredContent = {
  consignee: 'To order of Banco Exemplo S.A.',
  notifyParty: null,
  requirements: [
    { document: 'BILL_OF_LADING', originals: 3, copies: 3 },
    { document: 'PHYTOSANITARY_CERTIFICATE', originals: 1, copies: 0 },
  ],
};

describe('sameContent', () => {
  it('is true for the same content, whatever the key order of the requirements', () => {
    expect(
      sameContent(content, {
        ...content,
        requirements: [
          { copies: 3, originals: 3, document: 'BILL_OF_LADING' },
          { document: 'PHYTOSANITARY_CERTIFICATE', copies: 0, originals: 1 },
        ],
      }),
    ).toBe(true);
  });

  it.each<[string, Partial<StoredContent>]>([
    ['another consignee', { consignee: 'To order' }],
    ['a notify party', { notifyParty: 'Rhine Valley Crushers GmbH' }],
    [
      'another count',
      {
        requirements: [
          { document: 'BILL_OF_LADING', originals: 3, copies: 2 },
          { document: 'PHYTOSANITARY_CERTIFICATE', originals: 1, copies: 0 },
        ],
      },
    ],
    ['another order', { requirements: [...content.requirements].reverse() }],
    ['one requirement fewer', { requirements: content.requirements.slice(0, 1) }],
  ])('is false for %s', (_case, change) => {
    expect(sameContent(content, { ...content, ...change })).toBe(false);
  });
});

describe('toStoredContent', () => {
  it('stores an absent notify party as null', () => {
    expect(
      toStoredContent({ consignee: content.consignee, requirements: [...content.requirements] }),
    ).toEqual(content);
  });
});
