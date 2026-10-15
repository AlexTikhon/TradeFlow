import { describe, expect, it } from 'vitest';
import {
  formatCalendarDate,
  formatCountry,
  formatInstant,
  formatLaycan,
  formatQuantity,
  localTimeZone,
} from './format';

describe('formatQuantity', () => {
  it('groups thousands and drops insignificant zeros', () => {
    expect(formatQuantity({ amount: '50000.000', unit: 'MT' })).toBe('50,000 MT');
  });

  it('keeps meaningful decimals', () => {
    expect(formatQuantity({ amount: '33000.125', unit: 'MT' })).toBe('33,000.125 MT');
  });
});

describe('calendar dates', () => {
  // The test run uses TZ=America/Sao_Paulo (UTC-3); see vite.config.ts.
  it('does not shift a date into the previous day west of UTC', () => {
    expect(formatCalendarDate('2026-09-25')).toBe('25 Sept 2026');
  });

  it('formats a laycan window as a compact range', () => {
    // Intl separates range parts with thin spaces (U+2009); compare on normalised whitespace.
    const formatted = formatLaycan({ start: '2026-09-25', end: '2026-10-04' });
    expect(formatted.replace(/\s/g, ' ')).toBe('25 Sept – 4 Oct 2026');
  });
});

describe('instants', () => {
  // The test run uses TZ=America/Sao_Paulo (UTC-3); see vite.config.ts.
  it("shows an instant in the viewer's time zone and names the offset", () => {
    expect(formatInstant('2026-10-20T17:00:00.000Z')).toBe('20 Oct 2026, 14:00 GMT-3');
  });

  it('crosses midnight with the time zone, not with UTC', () => {
    expect(formatInstant('2026-10-21T01:30:00.000Z')).toBe('20 Oct 2026, 22:30 GMT-3');
  });

  it("names the viewer's time zone", () => {
    expect(localTimeZone()).toBe('America/Sao_Paulo');
  });
});

describe('formatCountry', () => {
  it('names ISO country codes', () => {
    expect(formatCountry('BR')).toBe('Brazil');
  });
});
