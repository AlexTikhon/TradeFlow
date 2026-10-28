import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './app-config.js';

describe('loadConfig', () => {
  it('applies defaults and parses the port', () => {
    expect(
      loadConfig({ DATABASE_URL: 'postgresql://u:p@localhost:5433/tradeflow', PORT: '4000' }),
    ).toEqual({
      nodeEnv: 'development',
      port: 4000,
      databaseUrl: 'postgresql://u:p@localhost:5433/tradeflow',
      session: { ttlMs: 8 * 60 * 60_000, secureCookie: false },
      signIn: { attemptsPerMinute: 20 },
      documentStorage: { directory: resolve('var/documents') },
    });
  });

  it('uses secure cookies in production and honours the session lifetime', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://u:p@db:5432/tradeflow',
      SESSION_TTL_MINUTES: '30',
      DOCUMENT_STORAGE_DIR: '/srv/tradeflow/documents',
    });
    expect(config.session).toEqual({ ttlMs: 30 * 60_000, secureCookie: true });
    expect(config.documentStorage).toEqual({ directory: resolve('/srv/tradeflow/documents') });
  });

  it('requires a document storage directory in production', () => {
    expect(() =>
      loadConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgresql://u:p@db:5432/tradeflow' }),
    ).toThrow(/Required in production[\s\S]*DOCUMENT_STORAGE_DIR/);
  });

  it('fails fast listing every invalid variable', () => {
    expect(() => loadConfig({ DATABASE_URL: 'mysql://localhost/db', PORT: 'abc' })).toThrow(
      /DATABASE_URL[\s\S]*PORT|PORT[\s\S]*DATABASE_URL/,
    );
  });

  it('honours a sign-in budget of at least one attempt a minute', () => {
    const base = { DATABASE_URL: 'postgresql://u:p@db/t' };
    expect(loadConfig({ ...base, SIGN_IN_ATTEMPTS_PER_MINUTE: '50' }).signIn).toEqual({
      attemptsPerMinute: 50,
    });
    for (const value of ['0', '-1', '2.5', 'many']) {
      expect(() => loadConfig({ ...base, SIGN_IN_ATTEMPTS_PER_MINUTE: value })).toThrow(
        /SIGN_IN_ATTEMPTS_PER_MINUTE/,
      );
    }
  });

  it('rejects a session lifetime outside the allowed range', () => {
    expect(() =>
      loadConfig({ DATABASE_URL: 'postgresql://u:p@db/t', SESSION_TTL_MINUTES: '1' }),
    ).toThrow(/SESSION_TTL_MINUTES/);
  });
});
