import { describe, expect, it } from 'vitest';
import { TradeStringSchema } from './trade-string.js';

const exporter = {
  organization: { id: '01990000-0000-7000-8001-000000000001', name: 'Exporter', countryCode: 'BR' },
  role: 'EXPORTER',
};
const buyer = {
  organization: { id: '01990000-0000-7000-8001-000000000007', name: 'Buyer', countryCode: 'DE' },
  role: 'FINAL_BUYER',
};
const edge = {
  position: 1,
  sellerOrganizationId: exporter.organization.id,
  buyerOrganizationId: buyer.organization.id,
};

describe('TradeStringSchema', () => {
  it('accepts an empty string (no contracts recorded yet)', () => {
    expect(TradeStringSchema.parse({ parties: [], edges: [] })).toEqual({ parties: [], edges: [] });
  });

  it('accepts ordered parties and their connecting edges', () => {
    const value = { parties: [exporter, buyer], edges: [edge] };
    expect(TradeStringSchema.parse(value)).toEqual(value);
  });

  it.each(['SURVEYOR', 'SHIPPING_AGENT'])('rejects a %s as a party', (role) => {
    expect(
      TradeStringSchema.safeParse({ parties: [{ ...exporter, role }, buyer], edges: [edge] })
        .success,
    ).toBe(false);
  });

  it.each([0, -1, 1.5])('rejects position %s', (position) => {
    expect(
      TradeStringSchema.safeParse({ parties: [exporter, buyer], edges: [{ ...edge, position }] })
        .success,
    ).toBe(false);
  });

  it('carries topology only: unknown fields such as prices are dropped', () => {
    const parsed = TradeStringSchema.parse({
      parties: [exporter, buyer],
      edges: [{ ...edge, price: '412.50', contractReference: 'S-123' }],
    });
    expect(Object.keys(parsed.edges[0] ?? {}).sort()).toEqual([
      'buyerOrganizationId',
      'position',
      'sellerOrganizationId',
    ]);
  });
});
