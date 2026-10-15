import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';

/*
 * Password hashing with argon2id from Node's own crypto module (no native add-on to build).
 * Hashes are stored as PHC strings, `$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>`, so the
 * parameters travel with each hash and can be raised later without invalidating old ones.
 */

interface Cost {
  /** Memory in KiB. */
  memory: number;
  passes: number;
  parallelism: number;
}

/** OWASP Password Storage Cheat Sheet minimum for argon2id: 19 MiB memory, 2 passes, 1 lane. */
const COST: Cost = { memory: 19_456, passes: 2, parallelism: 1 };

/**
 * Upper bounds for parameters read back from storage, so a corrupted row cannot make a
 * sign-in attempt allocate gigabytes or spin for minutes.
 */
const MAX_COST: Cost = { memory: 256 * 1024, passes: 10, parallelism: 8 };

const SALT_BYTES = 16;
const HASH_BYTES = 32;
const ARGON2_VERSION = 19; // 0x13, the only version Node implements

const PHC_PATTERN =
  /^\$argon2id\$v=(\d+)\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

function derive(password: string, salt: Buffer, cost: Cost, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2(
      'argon2id',
      { message: password, nonce: salt, tagLength: length, ...cost },
      (error, key) => {
        if (error) reject(error);
        else resolve(key);
      },
    );
  });
}

// PHC strings use unpadded standard base64.
const toB64 = (bytes: Buffer) => bytes.toString('base64').replace(/=+$/, '');

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await derive(password, salt, COST, HASH_BYTES);
  const { memory, passes, parallelism } = COST;
  return `$argon2id$v=${ARGON2_VERSION}$m=${memory},t=${passes},p=${parallelism}$${toB64(salt)}$${toB64(hash)}`;
}

interface ParsedHash {
  cost: Cost;
  salt: Buffer;
  hash: Buffer;
}

function parse(phc: string): ParsedHash | null {
  const match = PHC_PATTERN.exec(phc);
  if (!match) return null;
  const [, version, memory, passes, parallelism, salt = '', hash = ''] = match;
  const cost: Cost = {
    memory: Number(memory),
    passes: Number(passes),
    parallelism: Number(parallelism),
  };
  if (
    Number(version) !== ARGON2_VERSION ||
    cost.memory > MAX_COST.memory ||
    cost.passes > MAX_COST.passes ||
    cost.parallelism > MAX_COST.parallelism
  ) {
    return null;
  }
  return { cost, salt: Buffer.from(salt, 'base64'), hash: Buffer.from(hash, 'base64') };
}

/**
 * Checks a password against a stored PHC string in constant time. A malformed or
 * out-of-bounds stored hash verifies as false rather than throwing.
 */
export async function verifyPassword(password: string, phc: string): Promise<boolean> {
  const parsed = parse(phc);
  if (!parsed) return false;
  try {
    const candidate = await derive(password, parsed.salt, parsed.cost, parsed.hash.length);
    return timingSafeEqual(candidate, parsed.hash);
  } catch {
    // Parameters Node rejects (for example a salt that is too short) can never match.
    return false;
  }
}
