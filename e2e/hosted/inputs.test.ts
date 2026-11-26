import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ENVIRONMENT, InputError, parseInputs } from './inputs.js';

const PASSWORDS = {
  seller: 'seller-password-for-tests-only',
  buyer: 'buyer-password-for-tests-only',
  outsider: 'outsider-password-for-tests-only',
};
const env: Record<string, string> = {
  [ENVIRONMENT.seller.email]: 'seller@verification.tradeflow.example',
  [ENVIRONMENT.seller.password]: PASSWORDS.seller,
  [ENVIRONMENT.buyer.email]: 'buyer@verification.tradeflow.example',
  [ENVIRONMENT.buyer.password]: PASSWORDS.buyer,
  [ENVIRONMENT.outsider.email]: 'outsider@verification.tradeflow.example',
  [ENVIRONMENT.outsider.password]: PASSWORDS.outsider,
};
const trust = JSON.stringify({
  ca: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n',
  spki: `${'A'.repeat(43)}=`,
  httpOrigin: 'http://localhost:51234',
});
const noFiles = (): string => {
  throw new Error('no file expected');
};
const refused = (
  argv: string[],
  pattern: RegExp,
  environment = env,
  read: (path: string) => string = noFiles,
) => {
  assert.throws(
    () => parseInputs(argv, environment, read),
    (error: unknown) => {
      assert.ok(error instanceof InputError, 'an InputError');
      assert.match(error.message, pattern);
      for (const secret of Object.values(PASSWORDS)) assert.ok(!error.message.includes(secret));
      return true;
    },
  );
};

void describe('hosted verification inputs', () => {
  void it('accepts an explicit HTTPS origin with credentials from the environment', () => {
    const inputs = parseInputs(['--origin', 'https://portfolio.tradeflow.example'], env, noFiles);
    assert.equal(inputs.origin, 'https://portfolio.tradeflow.example');
    assert.equal(inputs.httpOrigin, 'http://portfolio.tradeflow.example');
    assert.deepEqual(inputs.trust, { kind: 'public' });
    assert.equal(inputs.mode, 'full');
    assert.equal(inputs.accounts.buyer.password, PASSWORDS.buyer);
    assert.equal(inputs.restartTimeoutMs, 15 * 60_000);
  });

  void it('has no default target and never falls back to localhost', () => {
    refused([], /--origin is required/);
    refused(['--origin', 'https://localhost:8443'], /DNS name/);
    refused(['--origin', 'https://app.localhost'], /DNS name/);
    refused(['--origin', 'https://127.0.0.1'], /DNS name/);
    refused(['--origin', 'https://[::1]:8443'], /DNS name/);
    refused(['--origin', 'https://203.0.113.10'], /DNS name/);
  });

  void it('accepts only an HTTPS origin, without credentials, path, query or fragment', () => {
    refused(['--origin', 'http://portfolio.tradeflow.example'], /https/);
    refused(['--origin', 'https://user:pass@portfolio.tradeflow.example'], /credentials/);
    refused(['--origin', 'https://portfolio.tradeflow.example/app'], /origin only/);
    refused(['--origin', 'https://portfolio.tradeflow.example/?x=1'], /origin only/);
    refused(['--origin', 'not a url'], /not a valid URL/);
  });

  void it('names every missing credential variable, and no value', () => {
    refused(
      ['--origin', 'https://portfolio.tradeflow.example'],
      /SELLER_PASSWORD.*OUTSIDER_EMAIL/,
      {
        ...env,
        [ENVIRONMENT.seller.password]: '',
        [ENVIRONMENT.outsider.email]: '',
      },
    );
    refused(['--origin', 'https://portfolio.tradeflow.example'], /three different accounts/, {
      ...env,
      [ENVIRONMENT.outsider.email]: env[ENVIRONMENT.buyer.email] ?? '',
    });
  });

  void it('refuses unknown or repeated arguments, so a password cannot be passed as one', () => {
    refused(
      ['--origin', 'https://portfolio.tradeflow.example', '--password', PASSWORDS.seller],
      /Unknown argument/,
    );
    refused(['--origin', 'https://a.example', '--origin', 'https://b.example'], /twice/);
    refused(['--origin'], /needs a value/);
  });

  void it('keeps local mock trust separate: only for https://localhost, only from its file', () => {
    const inputs = parseInputs(
      ['--origin', 'https://localhost:51235', '--local-mock-trust', 'trust.json'],
      env,
      () => trust,
    );
    assert.equal(inputs.trust.kind, 'local-mock');
    assert.equal(inputs.httpOrigin, 'http://localhost:51234');
    refused(
      ['--origin', 'https://portfolio.tradeflow.example', '--local-mock-trust', 'trust.json'],
      /only to https:\/\/localhost/,
      env,
      () => trust,
    );
    refused(
      ['--origin', 'https://localhost:51235', '--local-mock-trust', 'trust.json'],
      /mock CA/,
      env,
      () => '{"ca":"x"}',
    );
  });

  void it('requires an expectation for, and only for, a restored run', () => {
    refused(['--origin', 'https://a.example', '--mode', 'restored'], /--expect/);
    refused(['--origin', 'https://a.example', '--expect', 'results.json'], /restored/);
    refused(['--origin', 'https://a.example', '--mode', 'other'], /full or restored/);
    refused(['--origin', 'https://a.example', '--restart-timeout', '0'], /minutes/);
  });
});
