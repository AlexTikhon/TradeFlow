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

/** "BR" -> "Brazil", falling back to the code itself. */
export function formatCountry(countryCode: string): string {
  return regionNames.of(countryCode) ?? countryCode;
}
