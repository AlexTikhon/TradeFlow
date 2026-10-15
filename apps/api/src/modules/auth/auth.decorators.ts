import {
  applyDecorators,
  createParamDecorator,
  type ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import { ApiCookieAuth, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { schemaRef, SESSION_SECURITY_SCHEME } from '../../common/http/openapi.js';
import type { AuthenticatedRequest, Principal } from './principal.js';

export const IS_PUBLIC = Symbol('isPublic');

/**
 * Opts a route out of authentication. Every route requires a session unless it says otherwise,
 * so a new endpoint is protected by default.
 */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Documents that a controller or route needs the session cookie and can answer 401. */
export const ApiSessionAuth = () =>
  applyDecorators(
    ApiCookieAuth(SESSION_SECURITY_SCHEME),
    ApiUnauthorizedResponse({
      description: 'No valid session',
      schema: schemaRef('ProblemDetails'),
    }),
  );

/** Injects the authenticated principal. Only valid on routes guarded by `AuthGuard`. */
export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Principal => {
    const { principal } = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!principal) {
      // A programming error (a public route asking for a principal), not a client error.
      throw new Error('CurrentPrincipal used on a route without an authenticated principal');
    }
    return principal;
  },
);
