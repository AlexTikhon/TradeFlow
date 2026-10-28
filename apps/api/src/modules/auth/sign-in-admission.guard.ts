import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { TooManyRequestsException } from '../../common/http/too-many-requests.exception.js';
import { SignInAdmission } from './sign-in-admission.js';

/**
 * Spends one attempt of the caller's sign-in budget (ADR 0018), before the body is validated
 * and before any credential is looked up. Runs after the global guards, so a cross-site request
 * is refused as such and spends nothing.
 */
@Injectable()
export class SignInAdmissionGuard implements CanActivate {
  constructor(private readonly admission: SignInAdmission) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const admission = this.admission.admitAttempt(clientAddressOf(request));
    if (!admission.admitted) {
      throw new TooManyRequestsException(
        'Too many sign-in attempts. Try again later.',
        admission.retryAfterMs,
      );
    }
    return true;
  }
}

/**
 * The address the connection came from. `trust proxy` is not enabled, so Express derives
 * `request.ip` from the socket and ignores `X-Forwarded-For` and similar headers, which any
 * client can write.
 */
function clientAddressOf(request: Request): string {
  return request.ip ?? request.socket.remoteAddress ?? 'unknown';
}
