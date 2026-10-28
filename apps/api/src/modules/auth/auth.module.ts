import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.js';
import { AuthController } from './auth.controller.js';
import { AuthGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import { SameOriginGuard } from './same-origin.guard.js';
import { SessionCookie } from './session-cookie.js';
import { SessionPrincipals } from './session-principals.js';
import {
  DEFAULT_SIGN_IN_ADMISSION_OPTIONS,
  SIGN_IN_ADMISSION_OPTIONS,
  SignInAdmission,
  type SignInAdmissionOptions,
} from './sign-in-admission.js';
import { SignInAdmissionGuard } from './sign-in-admission.guard.js';

@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    SessionCookie,
    SessionPrincipals,
    SignInAdmission,
    SignInAdmissionGuard,
    {
      provide: SIGN_IN_ADMISSION_OPTIONS,
      useFactory: (config: AppConfig): SignInAdmissionOptions => ({
        ...DEFAULT_SIGN_IN_ADMISSION_OPTIONS,
        attemptsPerWindow: config.signIn.attemptsPerMinute,
      }),
      inject: [APP_CONFIG],
    },
    // Global guards run in registration order: refuse cross-site writes, then authenticate.
    { provide: APP_GUARD, useClass: SameOriginGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [SessionCookie, SessionPrincipals],
})
export class AuthModule {}
