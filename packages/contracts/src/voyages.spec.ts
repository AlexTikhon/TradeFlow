import { describe, expect, it } from 'vitest';
import { ListVoyagesQuerySchema, QuantitySchema, VoyageIdParamSchema } from './voyages.js';

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
