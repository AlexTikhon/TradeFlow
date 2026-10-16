import { describe, expect, it } from 'vitest';
import { describeOccurrence, formatOffset, resolveLocalDateTime } from './local-date-time';

// Every case names its zone: none depends on the zone the suite runs in, or on the clock.
const WARSAW = 'Europe/Warsaw';

describe('resolveLocalDateTime', () => {
  it.each([
    ['winter', '2026-01-15T09:00', '2026-01-15T08:00:00.000Z', '+01:00'],
    ['summer', '2026-07-15T09:00', '2026-07-15T07:00:00.000Z', '+02:00'],
    ['seconds and milliseconds', '2026-07-15T09:00:05.5', '2026-07-15T07:00:05.500Z', '+02:00'],
    ['just before the spring gap', '2026-03-29T01:59', '2026-03-29T00:59:00.000Z', '+01:00'],
    ['just after the spring gap', '2026-03-29T03:00', '2026-03-29T01:00:00.000Z', '+02:00'],
    ['just before the autumn overlap', '2026-10-25T01:59', '2026-10-24T23:59:00.000Z', '+02:00'],
    ['just after the autumn overlap', '2026-10-25T03:00', '2026-10-25T02:00:00.000Z', '+01:00'],
  ])('resolves an ordinary Warsaw time (%s) to its one instant', (_, local, instant, offset) => {
    expect(resolveLocalDateTime(local, WARSAW)).toEqual({
      kind: 'exact',
      occurrence: { instant, offset },
    });
  });

  it.each(['2026-03-29T02:00', '2026-03-29T02:30', '2026-03-29T02:59'])(
    'reports %s in Warsaw as nonexistent: the clocks go from 02:00 to 03:00',
    (local) => {
      expect(resolveLocalDateTime(local, WARSAW)).toEqual({ kind: 'nonexistent' });
    },
  );

  it.each([
    ['2026-10-25T02:00', '2026-10-25T00:00:00.000Z', '2026-10-25T01:00:00.000Z'],
    ['2026-10-25T02:30', '2026-10-25T00:30:00.000Z', '2026-10-25T01:30:00.000Z'],
    ['2026-10-25T02:59', '2026-10-25T00:59:00.000Z', '2026-10-25T01:59:00.000Z'],
  ])(
    'reports both occurrences of %s in Warsaw, summer time first, choosing neither',
    (local, first, second) => {
      expect(resolveLocalDateTime(local, WARSAW)).toEqual({
        kind: 'repeated',
        occurrences: [
          { instant: first, offset: '+02:00' },
          { instant: second, offset: '+01:00' },
        ],
      });
    },
  );

  it.each([
    ['Asia/Kolkata', '2026-03-29T02:30', '2026-03-28T21:00:00.000Z', '+05:30'],
    ['Asia/Kolkata', '2026-10-25T02:30', '2026-10-24T21:00:00.000Z', '+05:30'],
    ['America/Sao_Paulo', '2026-10-25T02:30', '2026-10-25T05:30:00.000Z', '-03:00'],
    ['UTC', '2026-03-29T02:30', '2026-03-29T02:30:00.000Z', '+00:00'],
  ])(
    'resolves Warsaw’s change-over times in %s, which has no DST, once',
    (zone, local, instant, offset) => {
      expect(resolveLocalDateTime(local, zone)).toEqual({
        kind: 'exact',
        occurrence: { instant, offset },
      });
    },
  );

  it.each([
    ['a day past the end of the month', '2026-02-30T10:00'],
    ['29 February outside a leap year', '2027-02-29T10:00'],
    ['month 13', '2026-13-01T10:00'],
    ['day 0', '2026-10-00T10:00'],
    ['hour 24', '2026-10-20T24:00'],
    ['minute 60', '2026-10-20T10:60'],
    ['second 60', '2026-10-20T10:00:60'],
    ['year 0', '0000-10-20T10:00'],
    ['a date without a time', '2026-10-20'],
    ['a time with an offset', '2026-10-20T10:00Z'],
    ['a space instead of T', '2026-10-20 10:00'],
    ['nothing', ''],
  ])('rejects %s instead of rolling it over', (_, local) => {
    expect(resolveLocalDateTime(local, WARSAW)).toEqual({ kind: 'invalid' });
  });

  it('accepts 29 February in a leap year', () => {
    expect(resolveLocalDateTime('2028-02-29T10:00', WARSAW)).toEqual({
      kind: 'exact',
      occurrence: { instant: '2028-02-29T09:00:00.000Z', offset: '+01:00' },
    });
  });
});

describe('formatOffset', () => {
  it.each([
    [0, '+00:00'],
    [2 * 3_600_000, '+02:00'],
    [-3 * 3_600_000, '-03:00'],
    [5.5 * 3_600_000, '+05:30'],
    [-(9 * 3_600_000 + 30 * 60_000), '-09:30'],
    [(1 * 3600 + 24 * 60) * 1000, '+01:24'],
    [(1 * 3600 + 24 * 60 + 40) * 1000, '+01:24:40'],
  ])('formats %d ms as %s', (offsetMs, text) => {
    expect(formatOffset(offsetMs)).toBe(text);
  });
});

describe('describeOccurrence', () => {
  it('gives the offset, then the instant in UTC', () => {
    expect(describeOccurrence({ instant: '2026-10-25T00:30:00.000Z', offset: '+02:00' })).toBe(
      'UTC+02:00 · 2026-10-25 00:30 UTC',
    );
  });

  it('shows seconds only when there are some', () => {
    expect(describeOccurrence({ instant: '2026-10-25T00:30:05.000Z', offset: '+02:00' })).toBe(
      'UTC+02:00 · 2026-10-25 00:30:05 UTC',
    );
  });
});
