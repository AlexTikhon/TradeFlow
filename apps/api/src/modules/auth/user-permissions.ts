import { ForbiddenException } from '@nestjs/common';
import type { Principal } from './principal.js';

/*
 * What a user may do on behalf of their organization (ADR 0008). Two roles, checked by name in
 * the service that performs each command: deliberately not a policy engine. Which voyages the
 * organization may act on is a separate question, answered by participation (ADR 0006).
 */

/** Viewers read; operators may also change their organization's voyages. */
export function requireOperator(principal: Principal, action: string): void {
  if (principal.role !== 'OPERATOR') {
    throw new ForbiddenException(`Your role does not allow you to ${action}.`);
  }
}
