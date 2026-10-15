import type { ParticipantRole, VoyageDetail, VoyageSummary } from '@tradeflow/contracts';
import type { Prisma } from '../../generated/prisma/client.js';

/*
 * Read model for voyage queries: exactly which columns are loaded, and how persistence rows
 * become API contract objects. Selecting explicitly (instead of `include`) means new columns
 * are never exposed by accident and every query loads only what the contract needs.
 */

export const voyageSummarySelect = {
  id: true,
  reference: true,
  status: true,
  quantity: true,
  quantityUnit: true,
  laycanStart: true,
  laycanEnd: true,
  updatedAt: true,
  vessel: { select: { id: true, name: true, imoNumber: true } },
  commodity: { select: { code: true, name: true } },
  loadPort: { select: { unLocode: true, name: true, countryCode: true } },
  dischargePort: { select: { unLocode: true, name: true, countryCode: true } },
} satisfies Prisma.VoyageSelect;

export const voyageDetailSelect = {
  ...voyageSummarySelect,
  createdAt: true,
  participants: {
    select: {
      role: true,
      organization: { select: { id: true, name: true, countryCode: true } },
    },
  },
} satisfies Prisma.VoyageSelect;

export type VoyageSummaryRow = Prisma.VoyageGetPayload<{ select: typeof voyageSummarySelect }>;
export type VoyageDetailRow = Prisma.VoyageGetPayload<{ select: typeof voyageDetailSelect }>;

/** Participants are listed in the order cargo and title flow, then service providers. */
const PARTICIPANT_ROLE_ORDER: Record<ParticipantRole, number> = {
  EXPORTER: 0,
  TRADER: 1,
  FINAL_BUYER: 2,
  SURVEYOR: 3,
  SHIPPING_AGENT: 4,
};

/** Quantity scale matches the column definition DECIMAL(14,3). */
const QUANTITY_SCALE = 3;

/** `date` columns arrive as UTC-midnight Date objects; the contract wants a calendar date. */
const toIsoDate = (date: Date) => date.toISOString().slice(0, 10);

export function toVoyageSummary(row: VoyageSummaryRow): VoyageSummary {
  return {
    id: row.id,
    reference: row.reference,
    status: row.status,
    vessel: row.vessel,
    commodity: row.commodity,
    quantity: { amount: row.quantity.toFixed(QUANTITY_SCALE), unit: row.quantityUnit },
    loadPort: row.loadPort,
    dischargePort: row.dischargePort,
    laycan: { start: toIsoDate(row.laycanStart), end: toIsoDate(row.laycanEnd) },
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toVoyageDetail(row: VoyageDetailRow): VoyageDetail {
  const participants = row.participants.toSorted(
    (a, b) =>
      PARTICIPANT_ROLE_ORDER[a.role] - PARTICIPANT_ROLE_ORDER[b.role] ||
      a.organization.name.localeCompare(b.organization.name),
  );
  return {
    ...toVoyageSummary(row),
    participants,
    createdAt: row.createdAt.toISOString(),
  };
}
