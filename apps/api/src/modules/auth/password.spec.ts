import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './password.js';

describe('password hashing', () => {
  it('produces a salted argon2id PHC string that verifies', async () => {
    const [first, second] = await Promise.all([hashPassword('s3cret'), hashPassword('s3cret')]);

    expect(first).toMatch(
      /^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/,
    );
    expect(first).not.toBe(second);
    expect(first).not.toContain('s3cret');
    await expect(verifyPassword('s3cret', first)).resolves.toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('s3cret');
    await expect(verifyPassword('S3cret', hash)).resolves.toBe(false);
  });

  it.each([
    ['empty', ''],
    ['plaintext', 's3cret'],
    ['other algorithm', '$argon2i$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0$aGFzaA'],
    ['excessive memory', '$argon2id$v=19$m=99999999,t=2,p=1$c2FsdHNhbHRzYWx0$aGFzaA'],
    ['too-short salt', '$argon2id$v=19$m=19456,t=2,p=1$c2E$aGFzaGhhc2hoYXNo'],
  ])('treats a malformed stored hash (%s) as a mismatch', async (_label, stored) => {
    await expect(verifyPassword('s3cret', stored)).resolves.toBe(false);
  });
});
