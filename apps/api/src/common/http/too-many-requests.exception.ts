import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * 429: the request was refused before any work, and may be sent again after `Retry-After`
 * (RFC 6585, RFC 9110 §10.2.3), which the Problem Details filter sets from `retryAfterSeconds`.
 */
export class TooManyRequestsException extends HttpException {
  /** Whole seconds, at least 1. */
  readonly retryAfterSeconds: number;

  constructor(message: string, retryAfterMs: number) {
    super(message, HttpStatus.TOO_MANY_REQUESTS);
    this.retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  }
}
