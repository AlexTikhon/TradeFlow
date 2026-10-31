import request from 'supertest';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { loadConfig } from '../src/config/app-config.js';
import { DEFAULT_SIGN_IN_ADMISSION_OPTIONS } from '../src/modules/auth/sign-in-admission.js';
import { createTestApp, type TestApp } from './support/test-app.js';

describe('Explicit reverse-proxy trust and sign-in admission', () => {
  let trusted: TestApp;
  let untrusted: TestApp;
  beforeAll(async () => {
    const options = { ...DEFAULT_SIGN_IN_ADMISSION_OPTIONS, attemptsPerWindow: 2, now: () => 0 };
    trusted = await createTestApp({
      config: loadConfig({ ...process.env, TRUSTED_PROXY_CIDRS: '127.0.0.1/32' }),
      signInAdmission: options,
    });
    untrusted = await createTestApp({
      config: loadConfig({ ...process.env, TRUSTED_PROXY_CIDRS: '192.0.2.254/32' }),
      signInAdmission: options,
    });
  });
  afterAll(async () => {
    await trusted.app.close();
    await untrusted.app.close();
  });
  const attempt = (ctx: TestApp, address: string) =>
    request(ctx.server).post('/api/auth/sign-in').set('X-Forwarded-For', address).send({});

  it('gives clients forwarded by an explicitly trusted peer separate budgets', async () => {
    await attempt(trusted, '198.51.100.1').expect(400);
    await attempt(trusted, '198.51.100.1').expect(400);
    await attempt(trusted, '198.51.100.1').expect(429);
    await attempt(trusted, '198.51.100.2').expect(400);
  });

  it('uses the nearest untrusted address, not a forged left-most value', async () => {
    await attempt(trusted, '192.0.2.1, 198.51.100.10').expect(400);
    await attempt(trusted, '192.0.2.2, 198.51.100.10').expect(400);
    await attempt(trusted, '192.0.2.3, 198.51.100.10').expect(429);
  });

  it('ignores all forwarded identities from a peer outside the configured allowlist', async () => {
    await attempt(untrusted, '198.51.100.21').expect(400);
    await attempt(untrusted, '198.51.100.22').expect(400);
    await attempt(untrusted, '198.51.100.23').expect(429);
  });
});
