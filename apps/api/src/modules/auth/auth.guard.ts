import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC } from './auth.decorators.js';
import { AuthService } from './auth.service.js';
import type { AuthenticatedRequest } from './principal.js';
import { SessionCookie } from './session-cookie.js';

/**
 * Global guard: every route requires a valid session unless marked `@Public()`.
 * Runs before pipes, so an unauthenticated request learns nothing from input validation.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
    private readonly cookie: SessionCookie,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = this.cookie.read(request);
    const principal = token === undefined ? null : await this.auth.authenticate(token);
    if (!principal) {
      throw new UnauthorizedException('Authentication is required.');
    }
    request.principal = principal;
    return true;
  }
}
