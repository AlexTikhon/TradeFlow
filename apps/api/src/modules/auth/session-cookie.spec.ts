import { describe, expect, it } from 'vitest';
import { readCookie } from './session-cookie.js';
import { generateSessionToken, isWellFormedSessionToken } from './session-token.js';

describe('readCookie', () => {
  it('finds the named cookie among others', () => {
    expect(readCookie('theme=dark; tradeflow_session=abc; lang=en', 'tradeflow_session')).toBe(
      'abc',
    );
  });

  it('does not match on a name suffix', () => {
    expect(readCookie('xtradeflow_session=abc', 'tradeflow_session')).toBeUndefined();
  });

  it('tolerates a missing header and undecodable values', () => {
    expect(readCookie(undefined, 'tradeflow_session')).toBeUndefined();
    expect(readCookie('tradeflow_session=%E0%A4%A', 'tradeflow_session')).toBeUndefined();
  });
});

describe('session tokens', () => {
  it('are 256-bit base64url strings that pass the shape check', () => {
    const token = generateSessionToken();
    expect(token).toHaveLength(43);
    expect(isWellFormedSessionToken(token)).toBe(true);
    expect(generateSessionToken()).not.toBe(token);
  });

  it.each(['', 'short', `${'a'.repeat(43)}=`, `${'a'.repeat(42)}!`])(
    'rejects %j before any lookup',
    (value) => {
      expect(isWellFormedSessionToken(value)).toBe(false);
    },
  );
});
