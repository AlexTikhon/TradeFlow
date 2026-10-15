import type { NoticeStatus } from '@tradeflow/contracts';

/*
 * MVP business rules for ETA notices (ADR 0011). Pure functions over instants; the service
 * supplies the server's clock.
 *
 * - The acknowledgement deadline lies after the moment of issue and not after the estimated
 *   arrival: a receipt confirmed once the vessel is in is of no use to the seller.
 * - A notice is overdue while it is ISSUED and its deadline has passed. Nothing is stored or
 *   scheduled when that happens; the state is derived whenever a notice is read.
 * - The buyer may still acknowledge an overdue notice. A late acknowledgement is recorded like
 *   any other; the notice stops being overdue, and its times show it was late.
 */

export interface NoticeDeadlines {
  estimatedArrivalAt: Date;
  acknowledgementDueAt: Date;
}

export interface NoticeDeadlineViolation {
  field: keyof NoticeDeadlines;
  message: string;
}

/** The deadline rules `deadlines` break when issued at `issuedAt`. Empty means valid. */
export function deadlineViolations(
  { estimatedArrivalAt, acknowledgementDueAt }: NoticeDeadlines,
  issuedAt: Date,
): NoticeDeadlineViolation[] {
  const violations: NoticeDeadlineViolation[] = [];
  if (acknowledgementDueAt.getTime() <= issuedAt.getTime()) {
    violations.push({
      field: 'acknowledgementDueAt',
      message: 'The acknowledgement deadline must be in the future',
    });
  }
  if (acknowledgementDueAt.getTime() > estimatedArrivalAt.getTime()) {
    violations.push({
      field: 'acknowledgementDueAt',
      message: 'The acknowledgement deadline must not be after the estimated arrival',
    });
  }
  return violations;
}

/** Overdue: still waiting for the buyer, and the deadline has passed. */
export function isOverdue(
  notice: { status: NoticeStatus; acknowledgementDueAt: Date },
  now: Date,
): boolean {
  return notice.status === 'ISSUED' && now.getTime() > notice.acknowledgementDueAt.getTime();
}

/** Acknowledged after the deadline. Allowed; recorded as a fact in the audit event. */
export const isLate = (acknowledgedAt: Date, acknowledgementDueAt: Date): boolean =>
  acknowledgedAt.getTime() > acknowledgementDueAt.getTime();
