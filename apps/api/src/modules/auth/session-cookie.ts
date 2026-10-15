import { Inject, Injectable } from '@nestjs/common';
import type { CookieOptions, Request, Response } from 'express';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.js';

/**
 * The session cookie: HttpOnly (no script access), SameSite=Strict (never sent on cross-site
 * requests), Path=/, and no Domain. Over HTTPS it is also Secure and carries the `__Host-`
 * prefix, which makes browsers refuse a copy set by a sibling subdomain.
 */
@Injectable()
export class SessionCookie {
  readonly name: string;
  private readonly options: CookieOptions;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    const secure = config.session.secureCookie;
    this.name = secure ? '__Host-tradeflow_session' : 'tradeflow_session';
    this.options = { httpOnly: true, secure, sameSite: 'strict', path: '/' };
  }

  read(request: Request): string | undefined {
    return readCookie(request.headers.cookie, this.name);
  }

  set(response: Response, token: string, expiresAt: Date): void {
    response.cookie(this.name, token, { ...this.options, expires: expiresAt });
  }

  clear(response: Response): void {
    response.clearCookie(this.name, this.options);
  }
}

/** Reads one cookie from a `Cookie` header. Avoids a cookie-parsing dependency for one value. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const pair of header?.split(';') ?? []) {
    const separator = pair.indexOf('=');
    if (separator > 0 && pair.slice(0, separator).trim() === name) {
      const value = pair.slice(separator + 1).trim();
      try {
        return decodeURIComponent(value);
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}
