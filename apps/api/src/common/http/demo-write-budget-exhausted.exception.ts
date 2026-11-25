import { HttpException, HttpStatus } from '@nestjs/common';

/** The stable title of `ProblemTypes.DemoWriteBudgetExhausted`. */
export const DEMO_WRITE_BUDGET_EXHAUSTED_TITLE = 'Demo change limit reached';

export const DEMO_WRITE_BUDGET_EXHAUSTED =
  'This demo has used up the changes it allows. You can still browse, download documents and ' +
  'sign in or out, but nothing more can be changed until an operator resets the demo, which ' +
  'restores the showcase and discards every change made since it started.';

/**
 * 429 from a business command on a portfolio demo whose write budget is used up (ADR 0021). The
 * Problem Details filter renders it with its own problem type and no `Retry-After`: waiting does
 * not help, only an operator reset does, so no retry time is invented.
 */
export class DemoWriteBudgetExhaustedException extends HttpException {
  constructor() {
    super(DEMO_WRITE_BUDGET_EXHAUSTED, HttpStatus.TOO_MANY_REQUESTS);
  }
}
