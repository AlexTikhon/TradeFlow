import type { Laycan, Quantity } from '@tradeflow/contracts';

// A fixed locale until the product has a localisation requirement.
const LOCALE = 'en-GB';

const quantityFormat = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 3 });

/**
 * Calendar dates (YYYY-MM-DD) carry no time zone. Formatting them in UTC prevents
 * "2026-09-25" being shown as 24 Sep to a user west of Greenwich.
 */
const calendarDateFormat = new Intl.DateTimeFormat(LOCALE, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

/**
 * Instants (timestamps) are shown in the viewer's own time zone, and say which one: two parties
 * reading the same notice on different continents must not misread each other's clocks.
 */
const instantFormat = new Intl.DateTimeFormat(LOCALE, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZoneName: 'short',
});

const regionNames = new Intl.DisplayNames(LOCALE, { type: 'region' });

/** "50,000 MT". The decimal string is formatted directly: it never becomes a float. */
export function formatQuantity({ amount, unit }: Quantity): string {
  return `${quantityFormat.format(amount as Intl.StringNumericLiteral)} ${unit}`;
}

export function formatCalendarDate(isoDate: string): string {
  return calendarDateFormat.format(new Date(isoDate));
}

/** "25 Sep – 4 Oct 2026" */
export function formatLaycan({ start, end }: Laycan): string {
  return calendarDateFormat.formatRange(new Date(start), new Date(end));
}

/** "20 Oct 2026, 14:00 GMT-3" for an ISO 8601 instant, in the viewer's time zone. */
export function formatInstant(isoInstant: string): string {
  return instantFormat.format(new Date(isoInstant));
}

/** The viewer's time zone, e.g. "America/Sao_Paulo". */
export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** "BR" -> "Brazil", falling back to the code itself. */
export function formatCountry(countryCode: string): string {
  return regionNames.of(countryCode) ?? countryCode;
}
