/**
 * Turns a wall-clock date and time in a named time zone (a `datetime-local` value such as
 * "2026-10-20T14:00") into instants, without guessing. Around a daylight-saving change a local
 * time can have no instant (the clocks skip it) or two (the clocks repeat it); `new Date()`
 * silently shifts or picks one, and also rolls "2026-02-30" over into March. Here each case is
 * reported, and choosing between two occurrences is left to the caller.
 */

export interface Occurrence {
  /** ISO 8601 in UTC, e.g. "2026-10-25T00:30:00.000Z". */
  instant: string;
  /** The zone's offset from UTC at that instant, e.g. "+02:00". */
  offset: string;
}

export type LocalDateTimeResolution =
  /** Not a local date and time, or not a real calendar date ("2026-02-30", "24:00"). */
  | { kind: 'invalid' }
  /** Skipped by the clocks going forward: no instant shows this time. */
  | { kind: 'nonexistent' }
  | { kind: 'exact'; occurrence: Occurrence }
  /** Repeated by the clocks going back: earlier occurrence first. */
  | { kind: 'repeated'; occurrences: [Occurrence, Occurrence] };

const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;

const DAY = 86_400_000;

const formatters = new Map<string, Intl.DateTimeFormat>();

function wallClockFormat(timeZone: string): Intl.DateTimeFormat {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, format);
  }
  return format;
}

/** Milliseconds since the epoch of these fields read as UTC, or undefined if they do not exist. */
function wallClockMs(fields: number[]): number | undefined {
  const [year = 0, month = 1, day = 1, hour = 0, minute = 0, second = 0, ms = 0] = fields;
  const date = new Date(0);
  // setUTCFullYear, unlike Date.UTC, does not read years 0–99 as 1900–1999.
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, ms);
  const roundTrips =
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second;
  return year >= 1 && roundTrips ? date.getTime() : undefined;
}

/** The zone's offset from UTC at an instant, in milliseconds (east of Greenwich is positive). */
function offsetAt(epochMs: number, timeZone: string): number {
  const wholeSecond = Math.floor(epochMs / 1000) * 1000;
  const parts = wallClockFormat(timeZone).formatToParts(wholeSecond);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value);
  const wall = wallClockMs([
    part('year'),
    part('month'),
    part('day'),
    part('hour'),
    part('minute'),
    part('second'),
  ]);
  return (wall ?? NaN) - wholeSecond;
}

/** "+02:00", "-03:00", "+05:30"; seconds only for historical local mean time. */
export function formatOffset(offsetMs: number): string {
  const sign = offsetMs < 0 ? '-' : '+';
  const total = Math.abs(offsetMs) / 1000;
  const pad = (n: number) => String(Math.floor(n)).padStart(2, '0');
  const hhmm = `${sign}${pad(total / 3600)}:${pad((total % 3600) / 60)}`;
  return total % 60 === 0 ? hhmm : `${hhmm}:${pad(total % 60)}`;
}

export function resolveLocalDateTime(
  localDateTime: string,
  timeZone: string,
): LocalDateTimeResolution {
  const match = LOCAL_DATE_TIME.exec(localDateTime);
  if (!match) {
    return { kind: 'invalid' };
  }
  const [, year, month, day, hour, minute, second = '0', fraction = ''] = match;
  // Milliseconds are a fraction: ".5" is 500, not 5.
  const milliseconds = fraction.padEnd(3, '0');
  const wall = wallClockMs([year, month, day, hour, minute, second, milliseconds].map(Number));
  if (wall === undefined) {
    return { kind: 'invalid' };
  }
  // The offsets in force a day either side cover any single change near this time; each is a
  // candidate, and it holds only if the zone really shows this wall-clock time at that instant.
  const offsets = new Set([wall - DAY, wall, wall + DAY].map((t) => offsetAt(t, timeZone)));
  const occurrences = [...offsets]
    .filter((offset) => offsetAt(wall - offset, timeZone) === offset)
    .map((offset) => ({ epochMs: wall - offset, offset }))
    .sort((a, b) => a.epochMs - b.epochMs)
    .map(({ epochMs, offset }) => ({
      instant: new Date(epochMs).toISOString(),
      offset: formatOffset(offset),
    }));
  const [earlier, later] = occurrences;
  if (!earlier) {
    return { kind: 'nonexistent' };
  }
  return later
    ? { kind: 'repeated', occurrences: [earlier, later] }
    : { kind: 'exact', occurrence: earlier };
}

/** "UTC+02:00 · 2026-10-25 00:30 UTC": the offset, then the instant itself. */
export function describeOccurrence({ instant, offset }: Occurrence): string {
  const seconds = instant.slice(16, 19);
  const time = seconds === ':00' ? instant.slice(11, 16) : instant.slice(11, 19);
  return `UTC${offset} · ${instant.slice(0, 10)} ${time} UTC`;
}
