import { describe, expect, it } from 'vitest';
import { Prisma } from '../../generated/prisma/client.js';
import { toVoyageDetail, type VoyageDetailRow } from './voyage.read-model.js';

const org = (name: string) => ({
  id: '01990000-0000-7000-8001-000000000001',
  name,
  countryCode: 'NL',
});

function detailRow(overrides: Partial<VoyageDetailRow> = {}): VoyageDetailRow {
  return {
    id: '01990000-0000-7000-8006-000000000001',
    reference: 'TF-2026-0001',
    status: 'IN_TRANSIT',
    quantity: new Prisma.Decimal('50000'),
    quantityUnit: 'MT',
    laycanStart: new Date('2026-09-25T00:00:00.000Z'),
    laycanEnd: new Date('2026-10-04T00:00:00.000Z'),
    createdAt: new Date('2026-09-01T08:30:00.000Z'),
    updatedAt: new Date('2026-10-01T12:00:00.000Z'),
    vessel: {
      id: '01990000-0000-7000-8003-000000000001',
      name: 'MV Horizon',
      imoNumber: '9341237',
    },
    commodity: { code: 'SOYBEANS', name: 'Soybeans' },
    loadPort: { unLocode: 'BRSSZ', name: 'Santos', countryCode: 'BR' },
    dischargePort: { unLocode: 'NLRTM', name: 'Rotterdam', countryCode: 'NL' },
    participants: [],
    ...overrides,
  };
}

describe('toVoyageDetail', () => {
  it('formats quantity at the column scale, never as a float', () => {
    const detail = toVoyageDetail(detailRow({ quantity: new Prisma.Decimal('50000.1') }));
    expect(detail.quantity).toEqual({ amount: '50000.100', unit: 'MT' });
  });

  it('keeps decimal precision beyond what a float can represent', () => {
    const detail = toVoyageDetail(detailRow({ quantity: new Prisma.Decimal('99999999999.999') }));
    expect(detail.quantity.amount).toBe('99999999999.999');
  });

  it('renders laycan as calendar dates and timestamps as ISO instants', () => {
    const detail = toVoyageDetail(detailRow());
    expect(detail.laycan).toEqual({ start: '2026-09-25', end: '2026-10-04' });
    expect(detail.createdAt).toBe('2026-09-01T08:30:00.000Z');
  });

  it('orders participants by trade flow, then service providers, then by name', () => {
    const detail = toVoyageDetail(
      detailRow({
        participants: [
          { role: 'SHIPPING_AGENT', organization: org('Agent') },
          { role: 'FINAL_BUYER', organization: org('Buyer') },
          { role: 'TRADER', organization: org('Zeta Trading') },
          { role: 'SURVEYOR', organization: org('Surveyor') },
          { role: 'TRADER', organization: org('Alpha Trading') },
          { role: 'EXPORTER', organization: org('Exporter') },
        ],
      }),
    );

    expect(detail.participants.map((p) => p.organization.name)).toEqual([
      'Exporter',
      'Alpha Trading',
      'Zeta Trading',
      'Buyer',
      'Surveyor',
      'Agent',
    ]);
  });
});
