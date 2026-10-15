import type { PrismaService } from '../../src/infrastructure/prisma/prisma.service.js';
import type { ParticipantRole, UserRole, VoyageStatus } from '../../src/generated/prisma/client.js';
import { hashPassword } from '../../src/modules/auth/password.js';
import { generateSessionToken, hashSessionToken } from '../../src/modules/auth/session-token.js';

/** Empties every application table (migrations history is kept). */
export async function resetDatabase(prisma: PrismaService): Promise<void> {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  const list = tables.map(({ tablename }) => `"public"."${tablename}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}

let sequence = 0;
const next = () => ++sequence;

/** Minimal reference data needed by voyages. Returns the created ids. */
export async function createReferenceData(prisma: PrismaService) {
  const n = next();
  const [vessel, commodity, loadPort, dischargePort] = await Promise.all([
    prisma.vessel.create({
      data: { name: `MV Test ${n}`, imoNumber: String(9000000 + n) },
    }),
    prisma.commodity.create({ data: { code: `TEST_${n}`, name: 'Soybeans' } }),
    prisma.port.create({ data: { unLocode: 'BRSSZ', name: 'Santos', countryCode: 'BR' } }),
    prisma.port.create({ data: { unLocode: 'NLRTM', name: 'Rotterdam', countryCode: 'NL' } }),
  ]);
  return { vessel, commodity, loadPort, dischargePort };
}

export async function createOrganization(prisma: PrismaService, name: string, countryCode = 'NL') {
  return prisma.organization.create({ data: { name, countryCode } });
}

interface VoyageFixture {
  reference: string;
  status?: VoyageStatus;
  quantity?: string;
  laycanStart?: string;
  laycanEnd?: string;
  participants?: { organizationId: string; role: ParticipantRole }[];
}

export async function createVoyage(
  prisma: PrismaService,
  refs: Awaited<ReturnType<typeof createReferenceData>>,
  fixture: VoyageFixture,
) {
  return prisma.voyage.create({
    data: {
      reference: fixture.reference,
      status: fixture.status ?? 'PLANNED',
      quantity: fixture.quantity ?? '50000',
      laycanStart: new Date(fixture.laycanStart ?? '2026-11-01'),
      laycanEnd: new Date(fixture.laycanEnd ?? '2026-11-10'),
      vesselId: refs.vessel.id,
      commodityId: refs.commodity.id,
      loadPortId: refs.loadPort.id,
      dischargePortId: refs.dischargePort.id,
      participants: { create: fixture.participants ?? [] },
    },
  });
}

/**
 * Records a trade string along `organizationIds`, from seller to buyer: contract 1 from the
 * first to the second, and so on. Each organization must already participate in the voyage in
 * one trade role. Writes rows directly, so the domain's chain rules are not checked.
 */
export async function createTradeString(
  prisma: PrismaService,
  voyageId: string,
  organizationIds: string[],
) {
  const participants = await prisma.voyageParticipant.findMany({
    where: { voyageId, role: { in: ['EXPORTER', 'TRADER', 'FINAL_BUYER'] } },
  });
  const participantOf = (organizationId: string) => {
    const participant = participants.find((p) => p.organizationId === organizationId);
    if (!participant) throw new Error(`${organizationId} is not a trade party on ${voyageId}`);
    return participant.id;
  };
  await prisma.tradeContract.createMany({
    data: organizationIds.slice(1).map((buyer, index) => ({
      voyageId,
      position: index + 1,
      sellerParticipantId: participantOf(organizationIds[index] ?? ''),
      buyerParticipantId: participantOf(buyer),
    })),
  });
}

/** Password of every user created by `createUser`. */
export const TEST_PASSWORD = 'correct horse battery staple';
// Hashing is deliberately slow; one hash serves every test user.
let testPasswordHash: Promise<string> | undefined;

export async function createUser(
  prisma: PrismaService,
  organizationId: string,
  {
    email = `user${next()}@example.com`,
    hasPassword = true,
    role = 'VIEWER',
  }: { email?: string; hasPassword?: boolean; role?: UserRole } = {},
) {
  testPasswordHash ??= hashPassword(TEST_PASSWORD);
  return prisma.user.create({
    data: {
      organizationId,
      email,
      fullName: `Test User ${email}`,
      role,
      passwordHash: hasPassword ? await testPasswordHash : null,
    },
  });
}

/**
 * Inserts a session directly, for states the API cannot produce on demand (already expired).
 * Returns the raw token, ready to send as the cookie value.
 */
export async function createSession(
  prisma: PrismaService,
  userId: string,
  { createdAt, expiresAt }: { createdAt: Date; expiresAt: Date },
) {
  const token = generateSessionToken();
  await prisma.session.create({
    data: { userId, tokenHash: hashSessionToken(token), createdAt, expiresAt },
  });
  return token;
}
