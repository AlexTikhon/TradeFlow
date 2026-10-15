import type { Prisma } from '../../generated/prisma/client.js';

/**
 * Takes the next voyage reference, `TF-<year>-<number>` (e.g. `TF-2026-0008`), numbered per
 * calendar year (UTC, database clock) and padded to at least four digits.
 *
 * Must run inside the transaction that creates the voyage. The upsert locks the year's counter
 * row until that transaction ends, so concurrent creations take numbers one after another, and
 * a creation that rolls back releases its number: references are unique and gapless. The
 * unique index on `voyages.reference` remains the last line of defence.
 */
export async function takeNextVoyageReference(tx: Prisma.TransactionClient): Promise<string> {
  const [counter] = await tx.$queryRaw<{ year: number; last_number: number }[]>`
    INSERT INTO voyage_reference_counters (year, last_number)
    VALUES (EXTRACT(YEAR FROM now() AT TIME ZONE 'UTC')::int, 1)
    ON CONFLICT (year)
      DO UPDATE SET last_number = voyage_reference_counters.last_number + 1
    RETURNING year, last_number`;
  if (!counter) {
    throw new Error('The voyage reference counter returned no row');
  }
  return `TF-${counter.year}-${String(counter.last_number).padStart(4, '0')}`;
}
