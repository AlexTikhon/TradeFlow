import { describe, expect, it } from 'vitest';
import { formatCalendarDate, formatCountry, formatLaycan, formatQuantity } from './format';

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

describe('formatCountry', () => {
  it('names ISO country codes', () => {
    expect(formatCountry('BR')).toBe('Brazil');
  });
});
