import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './auth.controller.js';
import { AuthGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import { SameOriginGuard } from './same-origin.guard.js';
import { SessionCookie } from './session-cookie.js';
import { SessionPrincipals } from './session-principals.js';

@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    SessionCookie,
    SessionPrincipals,
    // Global guards run in registration order: refuse cross-site writes, then authenticate.
    { provide: APP_GUARD, useClass: SameOriginGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [SessionCookie, SessionPrincipals],
})
export class AuthModule {}
