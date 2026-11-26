import { z } from 'zod';
import { loadConfig } from '../src/config/app-config.js';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service.js';
import { hashPassword } from '../src/modules/auth/password.js';

/*
 * Controlled preparation of the hosted verification accounts (docs/hosted-verification.md).
 * An explicit operator command, never run at boot. Creates or updates three fictional
 * organizations, one user in each, and the reference data a voyage needs. Passwords arrive as
 * JSON on standard input, never as arguments or environment variables, and are never printed.
 * The published demo password is refused. Nothing else in the database is touched.
 *
 *   printf '%s' '{"seller":"…","buyer":"…","outsider":"…"}' \
 *     | node --import tsx scripts/verification-fixtures.ts --confirm-database <host>:<port>/<database>
 */

const DEMO_PASSWORD = 'tradeflow-demo';
const MIN_PASSWORD_LENGTH = 16;
const MAX_STDIN_BYTES = 16 * 1024;

const Passwords = z
  .object({
    seller: z.string().min(MIN_PASSWORD_LENGTH).max(1024),
    buyer: z.string().min(MIN_PASSWORD_LENGTH).max(1024),
    outsider: z.string().min(MIN_PASSWORD_LENGTH).max(1024),
  })
  .strict();

const id = (n: number) => `01990000-0000-7000-9001-${n.toString().padStart(12, '0')}`;

/** Fixed, fictional, and recognizably fixtures wherever they appear (organization search, voyages). */
const ACCOUNTS = [
  {
    key: 'seller',
    organization: { id: id(1), name: 'Verification Seller (fixture)', countryCode: 'NL' },
    user: {
      id: id(11),
      email: 'seller@verification.tradeflow.example',
      fullName: 'Verification Seller',
      role: 'OPERATOR',
    },
  },
  {
    key: 'buyer',
    organization: { id: id(2), name: 'Verification Buyer (fixture)', countryCode: 'CH' },
    user: {
      id: id(12),
      email: 'buyer@verification.tradeflow.example',
      fullName: 'Verification Buyer',
      role: 'OPERATOR',
    },
  },
  {
    key: 'outsider',
    organization: { id: id(3), name: 'Verification Outsider (fixture)', countryCode: 'SG' },
    user: {
      id: id(13),
      email: 'outsider@verification.tradeflow.example',
      fullName: 'Verification Outsider',
      role: 'VIEWER',
    },
  },
] as const;

/** Matched by natural key, so rows that already exist (for example from another fixture) are reused. */
const VESSEL = { name: 'MV Verification Petrel', imoNumber: '9400007' } as const;
const COMMODITY = { code: 'SOYBEANS', name: 'Soybeans' } as const;
const PORTS = [
  { unLocode: 'BRSSZ', name: 'Santos', countryCode: 'BR' },
  { unLocode: 'NLRTM', name: 'Rotterdam', countryCode: 'NL' },
] as const;

/** `host:port/database` of a PostgreSQL URL, the way the operator confirms the target. */
function databaseTarget(url: string): string {
  const parsed = new URL(url);
  return `${parsed.hostname.toLowerCase()}:${parsed.port || '5432'}/${decodeURIComponent(parsed.pathname.slice(1))}`;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) throw new Error('Pipe the passwords as JSON on standard input');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = chunk as Buffer;
    size += bytes.length;
    if (size > MAX_STDIN_BYTES) throw new Error('Standard input is too large');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--confirm-database' || !args[1])
    throw new Error(
      'Usage: verification-fixtures.ts --confirm-database <host>:<port>/<database> (passwords as JSON on stdin)',
    );
  const config = loadConfig(process.env);
  const target = databaseTarget(config.databaseUrl);
  if (args[1].toLowerCase() !== target)
    throw new Error(
      `DATABASE_URL points at ${target}, not at the confirmed target; nothing written`,
    );
  let passwords: z.infer<typeof Passwords>;
  try {
    passwords = Passwords.parse(JSON.parse(await readStdin()));
  } catch {
    // Never echo the input or the parser's message: either could contain a password.
    throw new Error(
      `Expected {"seller","buyer","outsider"} passwords of at least ${String(MIN_PASSWORD_LENGTH)} characters on stdin`,
    );
  }
  const values = Object.values(passwords);
  if (values.includes(DEMO_PASSWORD)) throw new Error('The published demo password is refused');
  if (new Set(values).size !== values.length)
    throw new Error('Use a different password per account');

  const hashes = {
    seller: await hashPassword(passwords.seller),
    buyer: await hashPassword(passwords.buyer),
    outsider: await hashPassword(passwords.outsider),
  };
  const db = new PrismaService(config);
  try {
    const summary = await db.$transaction(async (tx) => {
      await tx.vessel.upsert({
        where: { imoNumber: VESSEL.imoNumber },
        update: {},
        create: VESSEL,
      });
      await tx.commodity.upsert({ where: { code: COMMODITY.code }, update: {}, create: COMMODITY });
      for (const port of PORTS)
        await tx.port.upsert({ where: { unLocode: port.unLocode }, update: {}, create: port });
      const accounts: { account: string; email: string; role: string; sessionsRevoked: number }[] =
        [];
      for (const { key, organization, user } of ACCOUNTS) {
        const { id: organizationId, ...organizationData } = organization;
        await tx.organization.upsert({
          where: { id: organizationId },
          update: organizationData,
          create: organization,
        });
        const { id: userId, ...userData } = user;
        const data = { ...userData, organizationId, passwordHash: hashes[key] };
        await tx.user.upsert({
          where: { id: userId },
          update: data,
          create: { id: userId, ...data },
        });
        // A (re)set password ends the account's earlier sessions.
        const revoked = await tx.session.updateMany({
          where: { userId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        accounts.push({
          account: key,
          email: user.email,
          role: user.role,
          sessionsRevoked: revoked.count,
        });
      }
      return accounts;
    });
    console.log(JSON.stringify({ target, accounts: summary }, null, 2));
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Fixture preparation failed');
  process.exitCode = 1;
});
