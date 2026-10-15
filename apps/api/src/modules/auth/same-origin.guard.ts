import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const ALLOWED_FETCH_SITES = new Set(['same-origin', 'none']);

/**
 * Cross-site request forgery defence in depth for cookie authentication (ADR 0007).
 * The primary control is `SameSite=Strict`; this guard also refuses state-changing requests
 * that the browser labels as coming from another site (`Sec-Fetch-Site`), which covers
 * same-site attackers such as a compromised sibling subdomain. Clients that send no fetch
 * metadata (curl, server-to-server) hold their own cookies and are not CSRF vectors.
 */
@Injectable()
export class SameOriginGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(request.method)) {
      return true;
    }
    const site = request.get('sec-fetch-site');
    if (site === undefined || ALLOWED_FETCH_SITES.has(site)) {
      return true;
    }
    throw new ForbiddenException('Cross-site requests are not accepted.');
  }
}
