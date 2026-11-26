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
      trustedProxyCidrs: [],
      databaseUrl: 'postgresql://u:p@localhost:5433/tradeflow',
      session: { ttlMs: 8 * 60 * 60_000, secureCookie: false },
      signIn: { attemptsPerMinute: 20 },
      documentStorage: { driver: 'local', directory: resolve('var/documents') },
      demoWriteBudget: { enabled: false },
      httpRequestLog: true,
    });
  });

  describe('HTTP request log', () => {
    const base = { DATABASE_URL: 'postgresql://u:p@db/t' };

    it('is on unless explicitly disabled, in every environment', () => {
      for (const NODE_ENV of ['development', 'test', 'production']) {
        const env = { ...base, NODE_ENV, DOCUMENT_STORAGE_DIR: '/srv/documents' };
        expect(loadConfig(env).httpRequestLog).toBe(true);
        expect(loadConfig({ ...env, HTTP_REQUEST_LOG: 'enabled' }).httpRequestLog).toBe(true);
        expect(loadConfig({ ...env, HTTP_REQUEST_LOG: 'disabled' }).httpRequestLog).toBe(false);
      }
    });

    it('refuses anything else', () => {
      for (const value of ['', 'true', 'off', 'Enabled', ' enabled']) {
        expect(() => loadConfig({ ...base, HTTP_REQUEST_LOG: value })).toThrow(/HTTP_REQUEST_LOG/);
      }
    });
  });

  describe('portfolio-demo write protection', () => {
    const base = { DATABASE_URL: 'postgresql://u:p@db/t' };

    it('is disabled unless explicitly enabled', () => {
      expect(loadConfig(base).demoWriteBudget).toEqual({ enabled: false });
      expect(
        loadConfig({ ...base, PORTFOLIO_DEMO_WRITE_PROTECTION: 'disabled' }).demoWriteBudget,
      ).toEqual({ enabled: false });
    });

    it('admits 200 business commands per dataset by default once enabled', () => {
      expect(
        loadConfig({ ...base, PORTFOLIO_DEMO_WRITE_PROTECTION: 'enabled' }).demoWriteBudget,
      ).toEqual({ enabled: true, allowance: 200 });
    });

    it('accepts a positive whole allowance up to one million', () => {
      for (const [value, allowance] of [
        ['1', 1],
        ['37', 37],
        ['1000000', 1_000_000],
      ] as const) {
        expect(
          loadConfig({
            ...base,
            PORTFOLIO_DEMO_WRITE_PROTECTION: 'enabled',
            PORTFOLIO_DEMO_WRITE_ALLOWANCE: value,
          }).demoWriteBudget,
        ).toEqual({ enabled: true, allowance });
      }
    });

    it('refuses any other allowance, and any other switch value', () => {
      for (const value of ['0', '-1', '1.5', '1e3', '0x10', ' 5', '007', '', 'abc', '1000001']) {
        expect(() =>
          loadConfig({
            ...base,
            PORTFOLIO_DEMO_WRITE_PROTECTION: 'enabled',
            PORTFOLIO_DEMO_WRITE_ALLOWANCE: value,
          }),
        ).toThrow('PORTFOLIO_DEMO_WRITE_ALLOWANCE');
      }
      for (const value of ['true', '1', 'on', 'ENABLED', '']) {
        expect(() => loadConfig({ ...base, PORTFOLIO_DEMO_WRITE_PROTECTION: value })).toThrow(
          'PORTFOLIO_DEMO_WRITE_PROTECTION',
        );
      }
    });

    it('refuses an allowance while protection is off, so no limit only looks configured', () => {
      for (const protection of [undefined, 'disabled']) {
        expect(() =>
          loadConfig({
            ...base,
            ...(protection && { PORTFOLIO_DEMO_WRITE_PROTECTION: protection }),
            PORTFOLIO_DEMO_WRITE_ALLOWANCE: '50',
          }),
        ).toThrow(/Only valid with PORTFOLIO_DEMO_WRITE_PROTECTION=enabled/);
      }
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
    expect(config.documentStorage).toEqual({
      driver: 'local',
      directory: resolve('/srv/tradeflow/documents'),
    });
  });

  it('accepts only explicit trusted proxy addresses and CIDRs', () => {
    const base = { DATABASE_URL: 'postgresql://u:p@db/t' };
    expect(
      loadConfig({ ...base, TRUSTED_PROXY_CIDRS: ' 172.29.0.2/32,::1/128 ' }).trustedProxyCidrs,
    ).toEqual(['172.29.0.2/32', '::1/128']);
    for (const value of [
      'true',
      '1',
      'loopback',
      '0.0.0.0/0',
      '::/0',
      '127.0.0.1/33',
      '::1/129',
      '127.0.0.1/-1',
      '127.0.0.1/1/2',
      '127.0.0.1,',
    ]) {
      expect(() => loadConfig({ ...base, TRUSTED_PROXY_CIDRS: value })).toThrow(
        'TRUSTED_PROXY_CIDRS',
      );
    }
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

  it('selects S3 without requiring a local directory in production', () => {
    expect(
      loadConfig({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://u:p@db/t',
        DOCUMENT_STORAGE_DRIVER: 's3',
        S3_BUCKET: 'private-documents',
        S3_REGION: 'eu-central-1',
      }).documentStorage,
    ).toEqual({
      driver: 's3',
      bucket: 'private-documents',
      region: 'eu-central-1',
      endpoint: undefined,
      forcePathStyle: false,
      prefix: 'tradeflow/',
    });
  });

  it.each([
    { S3_BUCKET: undefined },
    { S3_REGION: undefined },
    { S3_PREFIX: '../elsewhere/' },
    { S3_FORCE_PATH_STYLE: 'yes' },
    { S3_ENDPOINT: 'https://user:secret@storage.example' },
    { S3_ENDPOINT: 'https://storage.example?token=x' },
    { S3_ENDPOINT: 'http://storage.example', NODE_ENV: 'production' },
    { DOCUMENT_STORAGE_DRIVER: 'unknown' },
  ])('rejects invalid storage configuration: %j', (override) => {
    expect(() =>
      loadConfig({
        DATABASE_URL: 'postgresql://u:p@db/t',
        DOCUMENT_STORAGE_DRIVER: 's3',
        S3_BUCKET: 'private-documents',
        S3_REGION: 'eu-central-1',
        ...override,
      }),
    ).toThrow('Invalid environment configuration');
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

  it('listens on every interface unless HOST names one', () => {
    const base = { DATABASE_URL: 'postgresql://u:p@db/t' };
    expect(loadConfig(base).host).toBeUndefined();
    expect(loadConfig({ ...base, HOST: ' 127.0.0.1 ' }).host).toBe('127.0.0.1');
    expect(() => loadConfig({ ...base, HOST: ' ' })).toThrow(/HOST/);
  });

  it('rejects a session lifetime outside the allowed range', () => {
    expect(() =>
      loadConfig({ DATABASE_URL: 'postgresql://u:p@db/t', SESSION_TTL_MINUTES: '1' }),
    ).toThrow(/SESSION_TTL_MINUTES/);
  });
});
