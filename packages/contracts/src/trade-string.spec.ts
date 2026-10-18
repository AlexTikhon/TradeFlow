import { describe, expect, it } from 'vitest';
import { ConfigureTradeStringRequestSchema, TradeStringSchema } from './trade-string.js';

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

describe('ConfigureTradeStringRequestSchema', () => {
  const ids = Array.from(
    { length: 11 },
    (_, index) => `01990000-0000-7000-8001-${String(index + 1).padStart(12, '0')}`,
  );
  const parties = (count: number) =>
    ids.slice(0, count).map((organizationId) => ({ organizationId }));
  const issues = (value: unknown) => {
    const result = ConfigureTradeStringRequestSchema.safeParse(value);
    return result.success
      ? []
      : result.error.issues.map(({ path, message }) => ({ path: path.join('.'), message }));
  };

  it.each([2, 3, 10])('accepts %i distinct organizations in order', (count) => {
    expect(ConfigureTradeStringRequestSchema.parse({ parties: parties(count) })).toEqual({
      parties: parties(count),
    });
  });

  it.each([0, 1, 11])('rejects %i organizations', (count) => {
    expect(issues({ parties: parties(count) })).not.toEqual([]);
  });

  it('rejects an organization named twice, at its second place', () => {
    const [first, second] = parties(2);
    expect(issues({ parties: [first, second, first] })).toEqual([
      {
        path: 'parties.2.organizationId',
        message: 'This organization is already in the trade string',
      },
    ]);
  });

  it('rejects ids that are not UUIDs', () => {
    expect(issues({ parties: [{ organizationId: 'cerrado' }, ...parties(1)] })).toHaveLength(1);
  });

  it('is closed: roles, positions and unknown fields are refused, not ignored', () => {
    expect(
      issues({ parties: parties(2).map((party) => ({ ...party, role: 'TRADER' })) }),
    ).not.toEqual([]);
    expect(issues({ parties: parties(2), voyageId: ids[0] })).not.toEqual([]);
  });
});
