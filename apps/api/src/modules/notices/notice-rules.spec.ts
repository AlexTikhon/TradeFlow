import { describe, expect, it } from 'vitest';
import { deadlineViolations, isLate, isOverdue } from './notice-rules.js';

const issuedAt = new Date('2026-10-15T09:00:00.000Z');
const at = (iso: string) => new Date(iso);

describe('deadlineViolations', () => {
  it('accepts a deadline after the time of issue and before the arrival', () => {
    expect(
      deadlineViolations(
        {
          acknowledgementDueAt: at('2026-10-16T09:00:00.000Z'),
          estimatedArrivalAt: at('2026-10-20T09:00:00.000Z'),
        },
        issuedAt,
      ),
    ).toEqual([]);
  });

  it('accepts a deadline at the moment of arrival', () => {
    const arrival = at('2026-10-20T09:00:00.000Z');
    expect(
      deadlineViolations({ acknowledgementDueAt: arrival, estimatedArrivalAt: arrival }, issuedAt),
    ).toEqual([]);
  });

  it.each(['2026-10-15T09:00:00.000Z', '2026-10-15T08:59:59.999Z', '2026-01-01T00:00:00.000Z'])(
    'refuses a deadline at %s, not after the time of issue',
    (due) => {
      expect(
        deadlineViolations(
          { acknowledgementDueAt: at(due), estimatedArrivalAt: at('2026-10-20T09:00:00.000Z') },
          issuedAt,
        ),
      ).toEqual([
        {
          field: 'acknowledgementDueAt',
          message: 'The acknowledgement deadline must be in the future',
        },
      ]);
    },
  );

  it('refuses a deadline after the arrival', () => {
    expect(
      deadlineViolations(
        {
          acknowledgementDueAt: at('2026-10-20T09:00:00.001Z'),
          estimatedArrivalAt: at('2026-10-20T09:00:00.000Z'),
        },
        issuedAt,
      ),
    ).toEqual([
      {
        field: 'acknowledgementDueAt',
        message: 'The acknowledgement deadline must not be after the estimated arrival',
      },
    ]);
  });

  it('reports both when an arrival in the past drags the deadline with it', () => {
    expect(
      deadlineViolations(
        {
          acknowledgementDueAt: at('2026-10-14T09:00:00.000Z'),
          estimatedArrivalAt: at('2026-10-13T09:00:00.000Z'),
        },
        issuedAt,
      ).map((violation) => violation.message),
    ).toEqual([
      'The acknowledgement deadline must be in the future',
      'The acknowledgement deadline must not be after the estimated arrival',
    ]);
  });
});

describe('isOverdue', () => {
  const acknowledgementDueAt = at('2026-10-16T09:00:00.000Z');

  it('is false until the deadline has passed, inclusive of the deadline itself', () => {
    expect(isOverdue({ status: 'ISSUED', acknowledgementDueAt }, issuedAt)).toBe(false);
    expect(isOverdue({ status: 'ISSUED', acknowledgementDueAt }, acknowledgementDueAt)).toBe(false);
  });

  it('is true once an issued notice is past its deadline', () => {
    expect(
      isOverdue({ status: 'ISSUED', acknowledgementDueAt }, at('2026-10-16T09:00:00.001Z')),
    ).toBe(true);
  });

  it('is never true for an acknowledged notice, however late', () => {
    expect(
      isOverdue({ status: 'ACKNOWLEDGED', acknowledgementDueAt }, at('2027-01-01T00:00:00.000Z')),
    ).toBe(false);
  });
});

describe('isLate', () => {
  const due = at('2026-10-16T09:00:00.000Z');

  it('is true only for an acknowledgement after the deadline', () => {
    expect(isLate(at('2026-10-16T08:00:00.000Z'), due)).toBe(false);
    expect(isLate(due, due)).toBe(false);
    expect(isLate(at('2026-10-16T09:00:00.001Z'), due)).toBe(true);
  });
});
