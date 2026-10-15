import { BadRequestException } from '@nestjs/common';
import type { ProblemFieldError } from '@tradeflow/contracts';

/** A request whose params, query or body do not satisfy the API contract. */
export class RequestValidationException extends BadRequestException {
  constructor(readonly fieldErrors: ProblemFieldError[]) {
    super('The request is invalid.');
  }
}
