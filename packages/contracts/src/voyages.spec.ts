import { describe, expect, it } from 'vitest';
import {
  CreateVoyageRequestSchema,
  ListVoyagesQuerySchema,
  QuantitySchema,
  VoyageIdParamSchema,
} from './voyages.js';

describe('QuantitySchema', () => {
  it.each(['50000', '50000.000', '0.5'])('accepts exact decimal string %s', (amount) => {
    expect(QuantitySchema.safeParse({ amount, unit: 'MT' }).success).toBe(true);
  });

  it.each(['-1', '1e5', '50,000', '', '.5'])('rejects %s', (amount) => {
    expect(QuantitySchema.safeParse({ amount, unit: 'MT' }).success).toBe(false);
  });
});

describe('ListVoyagesQuerySchema', () => {
  it('accepts an empty query', () => {
    expect(ListVoyagesQuerySchema.parse({})).toEqual({});
  });

  it('rejects unknown statuses', () => {
    expect(ListVoyagesQuerySchema.safeParse({ status: 'SAILING' }).success).toBe(false);
  });
});

describe('VoyageIdParamSchema', () => {
  it('accepts a UUIDv7', () => {
    expect(VoyageIdParamSchema.safeParse('0199f0a0-0000-7000-8000-000000000001').success).toBe(
      true,
    );
  });

  it('rejects non-UUID identifiers', () => {
    expect(VoyageIdParamSchema.safeParse('TF-2026-0001').success).toBe(false);
  });
});

describe('CreateVoyageRequestSchema', () => {
  const valid = {
    vesselId: '01990000-0000-7000-8003-000000000001',
    commodityId: '01990000-0000-7000-8004-000000000001',
    quantity: { amount: '50000.125', unit: 'MT' },
    loadPortId: '01990000-0000-7000-8005-000000000001',
    dischargePortId: '01990000-0000-7000-8005-000000000005',
    laycan: { start: '2026-11-01', end: '2026-11-10' },
  };
  const issues = (input: unknown) =>
    CreateVoyageRequestSchema.safeParse(input).error?.issues.map(
      (issue) => `${issue.path.join('.')}: ${issue.message}`,
    ) ?? [];

  it('accepts a complete request and keeps the amount as the exact string sent', () => {
    expect(CreateVoyageRequestSchema.parse(valid).quantity.amount).toBe('50000.125');
  });

  it.each(['1', '0.001', '50000', '050.5', '99999999999.999'])('accepts amount %s', (amount) => {
    expect(issues({ ...valid, quantity: { amount, unit: 'MT' } })).toEqual([]);
  });

  it.each([
    ['1.0001', 'Use at most 3 decimal places'],
    ['100000000000', 'Must be less than 100,000,000,000'],
    ['0', 'Must be greater than zero'],
    ['0.000', 'Must be greater than zero'],
    ['-5', 'Enter a decimal number such as 50000 or 50000.125'],
    ['1e5', 'Enter a decimal number such as 50000 or 50000.125'],
    ['50,000', 'Enter a decimal number such as 50000 or 50000.125'],
    ['', 'Enter a decimal number such as 50000 or 50000.125'],
  ])('rejects amount %s instead of rounding it', (amount, message) => {
    expect(issues({ ...valid, quantity: { amount, unit: 'MT' } })).toEqual([
      `quantity.amount: ${message}`,
    ]);
  });

  it('rejects a numeric amount: quantities never travel as floats', () => {
    expect(issues({ ...valid, quantity: { amount: 50000, unit: 'MT' } })).toHaveLength(1);
  });

  it('requires the laycan to end on or after its start', () => {
    expect(issues({ ...valid, laycan: { start: '2026-11-10', end: '2026-11-10' } })).toEqual([]);
    expect(issues({ ...valid, laycan: { start: '2026-11-10', end: '2026-11-09' } })).toEqual([
      'laycan.end: Laycan end must not be before laycan start',
    ]);
  });

  it('rejects calendar dates that do not exist', () => {
    expect(issues({ ...valid, laycan: { start: '2026-02-30', end: '2026-03-02' } })).toHaveLength(
      1,
    );
  });

  it('requires distinct load and discharge ports', () => {
    expect(issues({ ...valid, dischargePortId: valid.loadPortId })).toEqual([
      'dischargePortId: Discharge port must differ from the load port',
    ]);
  });

  it('rejects fields the server decides, instead of ignoring them', () => {
    const [issue] =
      CreateVoyageRequestSchema.safeParse({
        ...valid,
        organizationId: '01990000-0000-7000-8001-000000000002',
        status: 'COMPLETED',
      }).error?.issues ?? [];
    expect(issue).toMatchObject({ code: 'unrecognized_keys', keys: ['organizationId', 'status'] });
  });
});
