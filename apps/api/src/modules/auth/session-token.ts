import { createHash, randomBytes } from 'node:crypto';

/*
 * Session tokens are 256 bits from the CSPRNG, base64url-encoded (43 characters). The database
 * stores only their SHA-256 digest: a fast hash is sufficient because the input is uniformly
 * random and cannot be guessed, unlike a password.
 */

const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const generateSessionToken = (): string => randomBytes(TOKEN_BYTES).toString('base64url');

/** Shape check before any database lookup, so garbage cookies cost nothing. */
export const isWellFormedSessionToken = (value: string): boolean => TOKEN_PATTERN.test(value);

export const hashSessionToken = (token: string): Uint8Array<ArrayBuffer> =>
  new Uint8Array(createHash('sha256').update(token).digest());
