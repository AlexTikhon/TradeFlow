import { describe, expect, it } from 'vitest';
import {
  OrganizationSearchQuerySchema,
  OrganizationSearchResponseSchema,
} from './organizations.js';

describe('OrganizationSearchQuerySchema', () => {
  it('trims the search text', () => {
    expect(OrganizationSearchQuerySchema.parse({ search: '  lac ' })).toEqual({ search: 'lac' });
  });

  it.each([undefined, '', ' a ', 'x'.repeat(101)])('rejects search %j', (search) => {
    expect(OrganizationSearchQuerySchema.safeParse({ search }).success).toBe(false);
  });

  it('accepts 2 to 100 characters', () => {
    expect(OrganizationSearchQuerySchema.safeParse({ search: 'ab' }).success).toBe(true);
    expect(OrganizationSearchQuerySchema.safeParse({ search: 'x'.repeat(100) }).success).toBe(true);
  });

  it('rejects a repeated parameter', () => {
    expect(OrganizationSearchQuerySchema.safeParse({ search: ['ab', 'cd'] }).success).toBe(false);
  });
});

describe('OrganizationSearchResponseSchema', () => {
  const organization = {
    id: '01990000-0000-7000-8001-000000000004',
    name: 'Lacustra Commodities SA',
    countryCode: 'CH',
  };

  it('carries the reference only: anything else is dropped', () => {
    const parsed = OrganizationSearchResponseSchema.parse({
      items: [{ ...organization, users: [], createdAt: '2026-10-15T00:00:00.000Z' }],
    });
    expect(parsed).toEqual({ items: [organization] });
  });

  it('holds at most 20 organizations', () => {
    const items = Array.from({ length: 21 }, () => organization);
    expect(OrganizationSearchResponseSchema.safeParse({ items }).success).toBe(false);
  });
});
