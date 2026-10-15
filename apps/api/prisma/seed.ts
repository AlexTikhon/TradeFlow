/**
 * Demo data seed. Idempotent: every row has a fixed id and is upserted, so the seed can be
 * re-run safely and demo URLs stay stable. All organizations and people are fictional.
 */
import { PrismaPg } from '@prisma/adapter-pg';
import {
  type ParticipantRole,
  PrismaClient,
  type VoyageStatus,
} from '../src/generated/prisma/client.js';

/** Deterministic UUIDv7-shaped ids: the 4th group identifies the entity kind. */
const seedId = (kind: string, n: number) =>
  `01990000-0000-7000-${kind}-${n.toString().padStart(12, '0')}`;

const ORG = (n: number) => seedId('8001', n);
const USER = (n: number) => seedId('8002', n);
const VESSEL = (n: number) => seedId('8003', n);
const COMMODITY = (n: number) => seedId('8004', n);
const PORT = (n: number) => seedId('8005', n);
const VOYAGE = (n: number) => seedId('8006', n);

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

const users = [
  {
    id: USER(1),
    organizationId: ORG(1),
    email: 'ana.souza@cerrado-graos.example',
    fullName: 'Ana Souza',
  },
  {
    id: USER(2),
    organizationId: ORG(1),
    email: 'rafael.lima@cerrado-graos.example',
    fullName: 'Rafael Lima',
  },
  {
    id: USER(3),
    organizationId: ORG(2),
    email: 'lucia.ferreyra@pampalitoral.example',
    fullName: 'Lucía Ferreyra',
  },
  {
    id: USER(4),
    organizationId: ORG(3),
    email: 'mark.hollis@gulfprairie.example',
    fullName: 'Mark Hollis',
  },
  {
    id: USER(5),
    organizationId: ORG(4),
    email: 'claire.morel@lacustra.example',
    fullName: 'Claire Morel',
  },
  {
    id: USER(6),
    organizationId: ORG(4),
    email: 'jonas.weber@lacustra.example',
    fullName: 'Jonas Weber',
  },
  {
    id: USER(7),
    organizationId: ORG(5),
    email: 'sanne.devries@nordlys.example',
    fullName: 'Sanne de Vries',
  },
  {
    id: USER(8),
    organizationId: ORG(6),
    email: 'wei.ling.tan@meridianagri.example',
    fullName: 'Tan Wei Ling',
  },
  {
    id: USER(9),
    organizationId: ORG(7),
    email: 'katrin.vogel@rhinevalley.example',
    fullName: 'Katrin Vogel',
  },
  {
    id: USER(10),
    organizationId: ORG(8),
    email: 'emre.kaya@anatoliamills.example',
    fullName: 'Emre Kaya',
  },
  {
    id: USER(11),
    organizationId: ORG(9),
    email: 'zhang.min@bohaifeed.example',
    fullName: 'Zhang Min',
  },
  {
    id: USER(12),
    organizationId: ORG(10),
    email: 'pablo.ortega@iberiafeeds.example',
    fullName: 'Pablo Ortega',
  },
  {
    id: USER(13),
    organizationId: ORG(11),
    email: 'pieter.bakker@atlasinspection.example',
    fullName: 'Pieter Bakker',
  },
  {
    id: USER(14),
    organizationId: ORG(12),
    email: 'joao.ribeiro@costaatlantica.example',
    fullName: 'João Ribeiro',
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
  id: string;
  reference: string;
  status: VoyageStatus;
  vesselId: string;
  commodityId: string;
  quantity: string;
  loadPortId: string;
  dischargePortId: string;
  laycan: [start: string, end: string];
  participants: [organizationId: string, role: ParticipantRole][];
}

const voyages: VoyageSeed[] = [
  {
    id: VOYAGE(1),
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
  },
  {
    id: VOYAGE(2),
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
  },
  {
    id: VOYAGE(3),
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
  },
  {
    id: VOYAGE(4),
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
  },
  {
    id: VOYAGE(5),
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
  },
  {
    id: VOYAGE(6),
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
  },
  {
    id: VOYAGE(7),
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
  },
];

async function seed(prisma: PrismaClient): Promise<void> {
  for (const { id, ...data } of organizations) {
    await prisma.organization.upsert({ where: { id }, update: data, create: { id, ...data } });
  }
  for (const { id, ...data } of users) {
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

  for (const { id, participants, laycan, ...fields } of voyages) {
    const data = {
      ...fields,
      laycanStart: new Date(laycan[0]),
      laycanEnd: new Date(laycan[1]),
    };
    // The seed owns these voyages, so their participant list is replaced wholesale.
    await prisma.$transaction([
      prisma.voyage.upsert({ where: { id }, update: data, create: { id, ...data } }),
      prisma.voyageParticipant.deleteMany({ where: { voyageId: id } }),
      prisma.voyageParticipant.createMany({
        data: participants.map(([organizationId, role]) => ({
          voyageId: id,
          organizationId,
          role,
        })),
      }),
    ]);
  }
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
      `${ports.length} ports, ${commodities.length} commodities, ${voyages.length} voyages.`,
  );
} finally {
  await prisma.$disconnect();
}
