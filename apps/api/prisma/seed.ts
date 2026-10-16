/**
 * Demo data seed. Idempotent: every row has a fixed id and is upserted (or, below a seeded
 * voyage, replaced), so the seed can be re-run safely and demo URLs stay stable. Notices are the
 * exception: they are replaced with fresh ids on each run (see planNotice). All organizations and
 * people are fictional.
 */
import { PrismaPg } from '@prisma/adapter-pg';
import {
  type ParticipantRole,
  PrismaClient,
  type VoyageStatus,
} from '../src/generated/prisma/client.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { deadlineViolations } from '../src/modules/notices/notice-rules.js';
import { toLinearTradeString } from '../src/modules/voyages/trade-string.js';

/**
 * Every demo user signs in with this password. It is published in the README, so it must only
 * ever be seeded into local or demo databases, never into an environment with real data.
 */
const DEMO_PASSWORD = 'tradeflow-demo';

/** Deterministic UUIDv7-shaped ids: the 4th group identifies the entity kind. */
const seedId = (kind: string, n: number) =>
  `01990000-0000-7000-${kind}-${n.toString().padStart(12, '0')}`;

const ORG = (n: number) => seedId('8001', n);
const USER = (n: number) => seedId('8002', n);
const VESSEL = (n: number) => seedId('8003', n);
const COMMODITY = (n: number) => seedId('8004', n);
const PORT = (n: number) => seedId('8005', n);
const VOYAGE = (n: number) => seedId('8006', n);
/** The `n`th participant of voyage `voyage`. */
const PARTICIPANT = (voyage: number, n: number) => seedId('8007', voyage * 100 + n);
/** The sale contract at `position` in voyage `voyage`'s trade string. */
const CONTRACT = (voyage: number, position: number) => seedId('8008', voyage * 100 + position);

const organizations = [
  { id: ORG(1), name: 'Cerrado Grãos Exportadora S.A.', countryCode: 'BR' },
  { id: ORG(2), name: 'Pampa Litoral Agroexport S.A.', countryCode: 'AR' },
  { id: ORG(3), name: 'Gulf Prairie Grain LLC', countryCode: 'US' },
  { id: ORG(4), name: 'Lacustra Commodities SA', countryCode: 'CH' },
  { id: ORG(5), name: 'Nordlys Trading B.V.', countryCode: 'NL' },
  { id: ORG(6), name: 'Meridian Agri Trading Pte. Ltd.', countryCode: 'SG' },
  { id: ORG(7), name: 'Rhine Valley Crushers GmbH', countryCode: 'DE' },
  { id: ORG(8), name: 'Anatolia Flour Mills A.Ş.', countryCode: 'TR' },
  { id: ORG(9), name: 'Bohai Feed Ingredients Co., Ltd.', countryCode: 'CN' },
  { id: ORG(10), name: 'Iberia Compound Feeds S.L.', countryCode: 'ES' },
  { id: ORG(11), name: 'Atlas Cargo Inspection B.V.', countryCode: 'NL' },
  { id: ORG(12), name: 'Costa Atlântica Agência Marítima Ltda.', countryCode: 'BR' },
] as const;

// Every organization has an operator (may create voyages). Cerrado and Lacustra also have a
// viewer (read-only), so both roles can be tried in the demo.
const users = [
  {
    id: USER(1),
    organizationId: ORG(1),
    email: 'ana.souza@cerrado-graos.example',
    fullName: 'Ana Souza',
    role: 'OPERATOR',
  },
  {
    id: USER(2),
    organizationId: ORG(1),
    email: 'rafael.lima@cerrado-graos.example',
    fullName: 'Rafael Lima',
    role: 'VIEWER',
  },
  {
    id: USER(3),
    organizationId: ORG(2),
    email: 'lucia.ferreyra@pampalitoral.example',
    fullName: 'Lucía Ferreyra',
    role: 'OPERATOR',
  },
  {
    id: USER(4),
    organizationId: ORG(3),
    email: 'mark.hollis@gulfprairie.example',
    fullName: 'Mark Hollis',
    role: 'OPERATOR',
  },
  {
    id: USER(5),
    organizationId: ORG(4),
    email: 'claire.morel@lacustra.example',
    fullName: 'Claire Morel',
    role: 'OPERATOR',
  },
  {
    id: USER(6),
    organizationId: ORG(4),
    email: 'jonas.weber@lacustra.example',
    fullName: 'Jonas Weber',
    role: 'VIEWER',
  },
  {
    id: USER(7),
    organizationId: ORG(5),
    email: 'sanne.devries@nordlys.example',
    fullName: 'Sanne de Vries',
    role: 'OPERATOR',
  },
  {
    id: USER(8),
    organizationId: ORG(6),
    email: 'wei.ling.tan@meridianagri.example',
    fullName: 'Tan Wei Ling',
    role: 'OPERATOR',
  },
  {
    id: USER(9),
    organizationId: ORG(7),
    email: 'katrin.vogel@rhinevalley.example',
    fullName: 'Katrin Vogel',
    role: 'OPERATOR',
  },
  {
    id: USER(10),
    organizationId: ORG(8),
    email: 'emre.kaya@anatoliamills.example',
    fullName: 'Emre Kaya',
    role: 'OPERATOR',
  },
  {
    id: USER(11),
    organizationId: ORG(9),
    email: 'zhang.min@bohaifeed.example',
    fullName: 'Zhang Min',
    role: 'OPERATOR',
  },
  {
    id: USER(12),
    organizationId: ORG(10),
    email: 'pablo.ortega@iberiafeeds.example',
    fullName: 'Pablo Ortega',
    role: 'OPERATOR',
  },
  {
    id: USER(13),
    organizationId: ORG(11),
    email: 'pieter.bakker@atlasinspection.example',
    fullName: 'Pieter Bakker',
    role: 'OPERATOR',
  },
  {
    id: USER(14),
    organizationId: ORG(12),
    email: 'joao.ribeiro@costaatlantica.example',
    fullName: 'João Ribeiro',
    role: 'OPERATOR',
  },
] as const;

// IMO numbers carry a valid check digit (weighted sum of the first six digits).
const vessels = [
  { id: VESSEL(1), name: 'MV Horizon', imoNumber: '9341237' },
  { id: VESSEL(2), name: 'MV Nordic Harvest', imoNumber: '9572812' },
  { id: VESSEL(3), name: 'MV Ocean Meridian', imoNumber: '9618434' },
  { id: VESSEL(4), name: 'MV Santa Clara Star', imoNumber: '9456783' },
  { id: VESSEL(5), name: 'MV Baltic Grace', imoNumber: '9703253' },
  { id: VESSEL(6), name: 'MV Cape Aurora', imoNumber: '9812640' },
] as const;

const commodities = [
  { id: COMMODITY(1), code: 'SOYBEANS', name: 'Soybeans' },
  { id: COMMODITY(2), code: 'YELLOW_CORN', name: 'Yellow Corn' },
  { id: COMMODITY(3), code: 'MILLING_WHEAT', name: 'Milling Wheat' },
  { id: COMMODITY(4), code: 'SOYBEAN_MEAL', name: 'Soybean Meal' },
] as const;

const ports = [
  { id: PORT(1), unLocode: 'BRSSZ', name: 'Santos', countryCode: 'BR' },
  { id: PORT(2), unLocode: 'BRPNG', name: 'Paranaguá', countryCode: 'BR' },
  { id: PORT(3), unLocode: 'ARROS', name: 'Rosario', countryCode: 'AR' },
  { id: PORT(4), unLocode: 'USMSY', name: 'New Orleans', countryCode: 'US' },
  { id: PORT(5), unLocode: 'NLRTM', name: 'Rotterdam', countryCode: 'NL' },
  { id: PORT(6), unLocode: 'DEHAM', name: 'Hamburg', countryCode: 'DE' },
  { id: PORT(7), unLocode: 'TRMER', name: 'Mersin', countryCode: 'TR' },
  { id: PORT(8), unLocode: 'CNDLC', name: 'Dalian', countryCode: 'CN' },
  { id: PORT(9), unLocode: 'ESTAR', name: 'Tarragona', countryCode: 'ES' },
] as const;

interface VoyageSeed {
  /** Picks the voyage's id, and its participants' and contracts' ids. */
  number: number;
  reference: string;
  status: VoyageStatus;
  vesselId: string;
  commodityId: string;
  quantity: string;
  loadPortId: string;
  dischargePortId: string;
  laycan: [start: string, end: string];
  participants: [organizationId: string, role: ParticipantRole][];
  /**
   * The trade string, as the organizations the cargo is sold through, exporter first: contract 1
   * is the first organization's sale to the second, and so on. Empty: no contracts recorded yet.
   */
  tradeString: string[];
}

const voyages: VoyageSeed[] = [
  {
    number: 1,
    reference: 'TF-2026-0001',
    status: 'IN_TRANSIT',
    vesselId: VESSEL(1),
    commodityId: COMMODITY(1),
    quantity: '50000.000',
    loadPortId: PORT(1),
    dischargePortId: PORT(5),
    laycan: ['2026-09-25', '2026-10-04'],
    participants: [
      [ORG(1), 'EXPORTER'],
      [ORG(4), 'TRADER'],
      [ORG(5), 'TRADER'],
      [ORG(7), 'FINAL_BUYER'],
      [ORG(11), 'SURVEYOR'],
      [ORG(12), 'SHIPPING_AGENT'],
    ],
    // Cerrado → Lacustra → Nordlys → Rhine Valley: two traders in the string.
    tradeString: [ORG(1), ORG(4), ORG(5), ORG(7)],
  },
  {
    number: 2,
    reference: 'TF-2026-0002',
    status: 'LOADING',
    vesselId: VESSEL(2),
    commodityId: COMMODITY(2),
    quantity: '60000.000',
    loadPortId: PORT(2),
    dischargePortId: PORT(9),
    laycan: ['2026-10-10', '2026-10-19'],
    participants: [
      [ORG(1), 'EXPORTER'],
      [ORG(6), 'TRADER'],
      [ORG(10), 'FINAL_BUYER'],
      [ORG(11), 'SURVEYOR'],
      [ORG(12), 'SHIPPING_AGENT'],
    ],
    tradeString: [ORG(1), ORG(6), ORG(10)],
  },
  {
    number: 3,
    reference: 'TF-2026-0003',
    status: 'PLANNED',
    vesselId: VESSEL(3),
    commodityId: COMMODITY(3),
    quantity: '33000.000',
    loadPortId: PORT(3),
    dischargePortId: PORT(7),
    laycan: ['2026-11-05', '2026-11-14'],
    participants: [
      [ORG(2), 'EXPORTER'],
      [ORG(4), 'TRADER'],
      [ORG(8), 'FINAL_BUYER'],
      [ORG(11), 'SURVEYOR'],
    ],
    // Parties have joined, but no sale contracts are recorded yet: "not configured" in the UI.
    tradeString: [],
  },
  {
    number: 4,
    reference: 'TF-2026-0004',
    status: 'DISCHARGING',
    vesselId: VESSEL(4),
    commodityId: COMMODITY(4),
    quantity: '30000.000',
    loadPortId: PORT(3),
    dischargePortId: PORT(6),
    laycan: ['2026-08-28', '2026-09-06'],
    participants: [
      [ORG(2), 'EXPORTER'],
      [ORG(5), 'TRADER'],
      [ORG(7), 'FINAL_BUYER'],
    ],
    tradeString: [ORG(2), ORG(5), ORG(7)],
  },
  {
    number: 5,
    reference: 'TF-2026-0005',
    status: 'PLANNED',
    vesselId: VESSEL(5),
    commodityId: COMMODITY(1),
    quantity: '65000.000',
    loadPortId: PORT(4),
    dischargePortId: PORT(8),
    laycan: ['2026-11-20', '2026-11-29'],
    participants: [
      [ORG(3), 'EXPORTER'],
      [ORG(6), 'TRADER'],
      [ORG(4), 'TRADER'],
      [ORG(9), 'FINAL_BUYER'],
      [ORG(11), 'SURVEYOR'],
    ],
    // Gulf Prairie → Meridian → Lacustra → Bohai. The traders' contract order is the reverse of
    // their alphabetical order (the participant directory lists Lacustra first).
    tradeString: [ORG(3), ORG(6), ORG(4), ORG(9)],
  },
  {
    number: 6,
    reference: 'TF-2026-0006',
    status: 'COMPLETED',
    vesselId: VESSEL(6),
    commodityId: COMMODITY(2),
    quantity: '55000.000',
    loadPortId: PORT(4),
    dischargePortId: PORT(9),
    laycan: ['2026-07-15', '2026-07-24'],
    participants: [
      [ORG(3), 'EXPORTER'],
      [ORG(5), 'TRADER'],
      [ORG(10), 'FINAL_BUYER'],
    ],
    tradeString: [ORG(3), ORG(5), ORG(10)],
  },
  {
    number: 7,
    reference: 'TF-2026-0007',
    status: 'CANCELLED',
    vesselId: VESSEL(4),
    commodityId: COMMODITY(1),
    quantity: '45000.000',
    loadPortId: PORT(2),
    dischargePortId: PORT(8),
    laycan: ['2026-10-28', '2026-11-06'],
    participants: [
      [ORG(1), 'EXPORTER'],
      [ORG(6), 'TRADER'],
      [ORG(9), 'FINAL_BUYER'],
    ],
    tradeString: [ORG(1), ORG(6), ORG(9)],
  },
];

interface NoticeSeed {
  number: number;
  /** The voyage (by number) and its contract (by position) the notice is issued under. */
  voyage: number;
  position: number;
  /** An operator of the contract's seller. */
  issuedBy: string;
  /**
   * Times in hours relative to when the seed runs (negative: in the past), so that each demo
   * notice stays in the state it is meant to show: acknowledged, awaiting, or overdue.
   */
  issued: number;
  due: number;
  arrival: number;
  message: string | null;
  /** An operator of the contract's buyer, and when they acknowledged. */
  acknowledged?: { by: string; at: number };
}

const noticeSeeds: NoticeSeed[] = [
  {
    // Cerrado → Lacustra, acknowledged by Lacustra in time.
    number: 1,
    voyage: 1,
    position: 1,
    issuedBy: USER(1),
    issued: -144,
    due: -96,
    arrival: 120,
    message: 'MV Horizon sailed Santos fully loaded. ETA Rotterdam as stated, weather permitting.',
    acknowledged: { by: USER(5), at: -120 },
  },
  {
    // Lacustra → Nordlys, awaiting Nordlys's acknowledgement.
    number: 2,
    voyage: 1,
    position: 2,
    issuedBy: USER(5),
    issued: -118,
    due: 24,
    arrival: 120,
    message: "Passing on our seller's ETA for MV Horizon at Rotterdam.",
  },
  {
    // Nordlys → Rhine Valley, past its deadline and still unacknowledged: overdue.
    number: 3,
    voyage: 1,
    position: 3,
    issuedBy: USER(7),
    issued: -96,
    due: -48,
    arrival: 120,
    message: null,
  },
  {
    // Cerrado → Meridian on TF-2026-0002, awaiting Meridian's acknowledgement.
    number: 4,
    voyage: 2,
    position: 1,
    issuedBy: USER(1),
    issued: -20,
    due: 52,
    arrival: 480,
    message: 'MV Nordic Harvest is loading at Paranaguá. ETA Tarragona after sailing.',
  },
];

/**
 * The row for one seeded notice. The issuer must work for the contract's seller and the
 * acknowledger for its buyer, and the deadlines must satisfy the same rules the API applies at
 * the time of issue. Anything else fails the seed before it writes.
 *
 * Unlike every other seeded row, a notice gets a fresh id on each run (the database assigns
 * it). Audit events are append-only and allow one acknowledgement event per notice id, so a
 * notice re-created under an id that was acknowledged through the API could never be
 * acknowledged again. No URL in the app names a notice, so nothing depends on stable ids.
 */
function planNotice(seed: NoticeSeed, now: Date) {
  const voyage = voyages.find((v) => v.number === seed.voyage);
  const seller = voyage?.tradeString[seed.position - 1];
  const buyer = voyage?.tradeString[seed.position];
  const organizationOf = (userId: string) => users.find((u) => u.id === userId)?.organizationId;
  const hours = (offset: number) => new Date(now.getTime() + offset * 3_600_000);
  const name = `Notice ${seed.number}`;
  if (!voyage || !seller || !buyer) {
    throw new Error(`${name}: voyage ${seed.voyage} has no contract at position ${seed.position}`);
  }
  if (organizationOf(seed.issuedBy) !== seller) {
    throw new Error(`${name}: the issuer does not work for the contract's seller`);
  }
  if (seed.acknowledged && organizationOf(seed.acknowledged.by) !== buyer) {
    throw new Error(`${name}: the acknowledger does not work for the contract's buyer`);
  }
  const issuedAt = hours(seed.issued);
  const deadlines = {
    estimatedArrivalAt: hours(seed.arrival),
    acknowledgementDueAt: hours(seed.due),
  };
  const violations = deadlineViolations(deadlines, issuedAt);
  if (violations.length > 0) {
    throw new Error(`${name}: ${violations.map((v) => v.message).join('; ')}`);
  }
  return {
    voyageId: VOYAGE(seed.voyage),
    tradeContractId: CONTRACT(seed.voyage, seed.position),
    type: 'ETA' as const,
    status: seed.acknowledged ? ('ACKNOWLEDGED' as const) : ('ISSUED' as const),
    ...deadlines,
    message: seed.message,
    issuedByUserId: seed.issuedBy,
    issuedByOrganizationId: seller,
    issuedAt,
    acknowledgedByUserId: seed.acknowledged?.by ?? null,
    acknowledgedByOrganizationId: seed.acknowledged ? buyer : null,
    acknowledgedAt: seed.acknowledged ? hours(seed.acknowledged.at) : null,
  };
}

/**
 * The rows for one seeded voyage, with fixed ids. Its trade string is checked with the same
 * domain rules the API reads it with (toLinearTradeString throws on any violation).
 */
function planVoyage({ number, participants, tradeString, laycan, ...fields }: VoyageSeed) {
  const id = VOYAGE(number);
  const participantRows = participants.map(([organizationId, role], index) => ({
    id: PARTICIPANT(number, index + 1),
    voyageId: id,
    organizationId,
    role,
  }));
  const participantOf = (organizationId: string) => {
    const row = participantRows.find((p) => p.organizationId === organizationId);
    if (!row) {
      throw new Error(
        `${fields.reference}: ${organizationId} is in the trade string but not a participant`,
      );
    }
    return { participantId: row.id, organizationId, role: row.role };
  };
  const { contracts } = toLinearTradeString(
    tradeString.slice(1).map((buyer, index) => ({
      position: index + 1,
      seller: participantOf(tradeString[index] ?? ''),
      buyer: participantOf(buyer),
    })),
  );
  return {
    id,
    data: { ...fields, laycanStart: new Date(laycan[0]), laycanEnd: new Date(laycan[1]) },
    participants: participantRows,
    contracts: contracts.map(({ position, seller, buyer }) => ({
      id: CONTRACT(number, position),
      voyageId: id,
      position,
      sellerParticipantId: seller.participantId,
      buyerParticipantId: buyer.participantId,
    })),
  };
}

async function seed(prisma: PrismaClient): Promise<void> {
  for (const { id, ...data } of organizations) {
    await prisma.organization.upsert({ where: { id }, update: data, create: { id, ...data } });
  }
  for (const { id, ...fields } of users) {
    // A fresh salt on every run; the password itself stays the same.
    const data = { ...fields, passwordHash: await hashPassword(DEMO_PASSWORD) };
    await prisma.user.upsert({ where: { id }, update: data, create: { id, ...data } });
  }
  for (const { id, ...data } of vessels) {
    await prisma.vessel.upsert({ where: { id }, update: data, create: { id, ...data } });
  }
  for (const { id, ...data } of commodities) {
    await prisma.commodity.upsert({ where: { id }, update: data, create: { id, ...data } });
  }
  for (const { id, ...data } of ports) {
    await prisma.port.upsert({ where: { id }, update: data, create: { id, ...data } });
  }

  // Plan every voyage and notice before writing any, so a seed whose trade string or notices
  // break the domain rules fails before it changes anything.
  const plans = voyages.map(planVoyage);
  const now = new Date();
  const notices = noticeSeeds.map((seed) => planNotice(seed, now));
  for (const { id, data, participants, contracts } of plans) {
    // The seed owns these voyages, so their participants, trade string and notices are replaced
    // wholesale (notices and documentary instructions first: they reference the contracts, which
    // reference the participants). Notices and instructions given through the API on a seeded
    // voyage go too (an instruction takes its revisions and acknowledgements with it); their
    // audit events stay. No instructions are seeded: the demo starts without any.
    await prisma.$transaction([
      prisma.voyage.upsert({ where: { id }, update: data, create: { id, ...data } }),
      prisma.notice.deleteMany({ where: { voyageId: id } }),
      prisma.documentaryInstruction.deleteMany({ where: { voyageId: id } }),
      prisma.tradeContract.deleteMany({ where: { voyageId: id } }),
      prisma.voyageParticipant.deleteMany({ where: { voyageId: id } }),
      prisma.voyageParticipant.createMany({ data: participants }),
      prisma.tradeContract.createMany({ data: contracts }),
      prisma.notice.createMany({ data: notices.filter((notice) => notice.voyageId === id) }),
    ]);
  }

  // Voyages created through the API continue numbering after the seeded references. Never
  // lowers a counter, so re-seeding after voyages were created cannot hand out a used number.
  await prisma.$executeRaw`
    INSERT INTO voyage_reference_counters (year, last_number)
    SELECT (regexp_match(reference, '^TF-(\d{4})-\d+$'))[1]::int,
           max((regexp_match(reference, '^TF-\d{4}-(\d+)$'))[1]::int)
    FROM voyages
    WHERE reference ~ '^TF-\d{4}-\d+$'
    GROUP BY 1
    ON CONFLICT (year)
      DO UPDATE SET last_number = GREATEST(voyage_reference_counters.last_number, EXCLUDED.last_number)`;
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is not set');
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
try {
  await seed(prisma);
  console.log(
    `Seeded ${organizations.length} organizations, ${users.length} users, ${vessels.length} vessels, ` +
      `${ports.length} ports, ${commodities.length} commodities, ${voyages.length} voyages ` +
      `(${voyages.filter((voyage) => voyage.tradeString.length > 0).length} with a trade string), ` +
      `${noticeSeeds.length} ETA notices. ` +
      `Every user's password is "${DEMO_PASSWORD}".`,
  );
} finally {
  await prisma.$disconnect();
}
