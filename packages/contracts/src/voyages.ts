import { z } from 'zod';
import { apiSchemaRegistry } from './registry.js';

export const VOYAGE_STATUSES = [
  'PLANNED',
  'LOADING',
  'IN_TRANSIT',
  'DISCHARGING',
  'COMPLETED',
  'CANCELLED',
] as const;

export const VoyageStatusSchema = z
  .enum(VOYAGE_STATUSES)
  .register(apiSchemaRegistry, { id: 'VoyageStatus' });

/**
 * The function an organization performs on a specific voyage.
 * Roles are contextual: the same organization can be an exporter on one voyage and a
 * final buyer on another, so the role is never stored on the organization itself.
 */
export const PARTICIPANT_ROLES = [
  'EXPORTER',
  'TRADER',
  'FINAL_BUYER',
  'SURVEYOR',
  'SHIPPING_AGENT',
] as const;

export const ParticipantRoleSchema = z
  .enum(PARTICIPANT_ROLES)
  .register(apiSchemaRegistry, { id: 'ParticipantRole' });

export const QUANTITY_UNITS = ['MT'] as const;

/**
 * Quantities are exact decimals. They travel as strings so no client ever
 * round-trips a cargo quantity through an IEEE-754 float.
 */
export const QuantitySchema = z
  .object({
    amount: z.string().regex(/^\d+(\.\d+)?$/, 'Expected a non-negative decimal string'),
    unit: z.enum(QUANTITY_UNITS),
  })
  .register(apiSchemaRegistry, { id: 'Quantity' });

export const PortSchema = z
  .object({
    id: z.uuid(),
    unLocode: z.string().regex(/^[A-Z]{2}[A-Z2-9]{3}$/, 'Expected a UN/LOCODE'),
    name: z.string(),
    countryCode: z.string().length(2),
  })
  .register(apiSchemaRegistry, { id: 'Port' });

export const VesselSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    imoNumber: z.string().regex(/^\d{7}$/, 'Expected a 7-digit IMO number'),
  })
  .register(apiSchemaRegistry, { id: 'Vessel' });

export const CommoditySchema = z
  .object({
    id: z.uuid(),
    code: z.string(),
    name: z.string(),
  })
  .register(apiSchemaRegistry, { id: 'Commodity' });

export const OrganizationRefSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    countryCode: z.string().length(2),
  })
  .register(apiSchemaRegistry, { id: 'OrganizationRef' });

export const VoyageParticipantSchema = z
  .object({
    organization: OrganizationRefSchema,
    role: ParticipantRoleSchema,
  })
  .register(apiSchemaRegistry, { id: 'VoyageParticipant' });

/** The date window in which the vessel must arrive at the load port. */
export const LaycanSchema = z
  .object({
    start: z.iso.date(),
    end: z.iso.date(),
  })
  .register(apiSchemaRegistry, { id: 'Laycan' });

export const VoyageSummarySchema = z
  .object({
    id: z.uuid(),
    reference: z.string(),
    status: VoyageStatusSchema,
    vessel: VesselSchema,
    commodity: CommoditySchema,
    quantity: QuantitySchema,
    loadPort: PortSchema,
    dischargePort: PortSchema,
    laycan: LaycanSchema,
    updatedAt: z.iso.datetime(),
  })
  .register(apiSchemaRegistry, { id: 'VoyageSummary' });

export const VoyageDetailSchema = VoyageSummarySchema.extend({
  participants: z.array(VoyageParticipantSchema),
  createdAt: z.iso.datetime(),
}).register(apiSchemaRegistry, { id: 'VoyageDetail' });

export const VoyageListResponseSchema = z
  .object({
    items: z.array(VoyageSummarySchema),
  })
  .register(apiSchemaRegistry, { id: 'VoyageListResponse' });

export const ListVoyagesQuerySchema = z.object({
  status: VoyageStatusSchema.optional(),
});

export const VoyageIdParamSchema = z.uuid();

/** Quantities are stored as DECIMAL(14,3): up to 11 digits before the point and 3 after. */
export const QUANTITY_MAX_INTEGER_DIGITS = 11;
export const QUANTITY_MAX_FRACTION_DIGITS = 3;

/**
 * A quantity amount a client submits. Exact: a decimal string, never a JSON number, and precision
 * the column cannot hold is rejected rather than rounded. Each rule has its own message, because
 * forms show them to people.
 */
export const QuantityAmountInputSchema = z
  .string()
  .superRefine((amount, context) => {
    const match = /^(\d+)(?:\.(\d+))?$/.exec(amount);
    if (!match) {
      context.addIssue({
        code: 'custom',
        message: 'Enter a decimal number such as 50000 or 50000.125',
      });
      return;
    }
    const integer = (match[1] ?? '').replace(/^0+/, '');
    const fraction = match[2] ?? '';
    if (fraction.length > QUANTITY_MAX_FRACTION_DIGITS) {
      context.addIssue({
        code: 'custom',
        message: `Use at most ${QUANTITY_MAX_FRACTION_DIGITS} decimal places`,
      });
    }
    if (integer.length > QUANTITY_MAX_INTEGER_DIGITS) {
      context.addIssue({ code: 'custom', message: 'Must be less than 100,000,000,000' });
    }
    if (integer === '' && /^0*$/.test(fraction)) {
      context.addIssue({ code: 'custom', message: 'Must be greater than zero' });
    }
  })
  .register(apiSchemaRegistry, {
    id: 'QuantityAmountInput',
    description:
      'A positive decimal string with at most 11 digits before the point and 3 after, e.g. ' +
      '"50000.125". Excess precision is rejected, not rounded.',
  });

/**
 * Body of `POST /api/voyages`. Only the shipment facts: the reference, status, participants and
 * audit actor are decided by the server from the signed-in identity, and a body that tries to
 * set them (or anything else unknown) is rejected rather than silently ignored.
 */
export const CreateVoyageRequestSchema = z
  .strictObject({
    vesselId: z.uuid(),
    commodityId: z.uuid(),
    quantity: z.strictObject({
      amount: QuantityAmountInputSchema,
      unit: z.enum(QUANTITY_UNITS),
    }),
    loadPortId: z.uuid(),
    dischargePortId: z.uuid(),
    laycan: z
      .strictObject({ start: z.iso.date(), end: z.iso.date() })
      // ISO calendar dates compare correctly as strings.
      .refine((laycan) => laycan.end >= laycan.start, {
        path: ['end'],
        message: 'Laycan end must not be before laycan start',
      }),
  })
  .refine((voyage) => voyage.loadPortId !== voyage.dischargePortId, {
    path: ['dischargePortId'],
    message: 'Discharge port must differ from the load port',
  })
  .register(apiSchemaRegistry, { id: 'CreateVoyageRequest' });

export const VesselListResponseSchema = z
  .object({ items: z.array(VesselSchema) })
  .register(apiSchemaRegistry, { id: 'VesselListResponse' });

export const CommodityListResponseSchema = z
  .object({ items: z.array(CommoditySchema) })
  .register(apiSchemaRegistry, { id: 'CommodityListResponse' });

export const PortListResponseSchema = z
  .object({ items: z.array(PortSchema) })
  .register(apiSchemaRegistry, { id: 'PortListResponse' });

export type VoyageStatus = z.infer<typeof VoyageStatusSchema>;
export type ParticipantRole = z.infer<typeof ParticipantRoleSchema>;
export type Quantity = z.infer<typeof QuantitySchema>;
export type Port = z.infer<typeof PortSchema>;
export type Vessel = z.infer<typeof VesselSchema>;
export type Commodity = z.infer<typeof CommoditySchema>;
export type OrganizationRef = z.infer<typeof OrganizationRefSchema>;
export type VoyageParticipant = z.infer<typeof VoyageParticipantSchema>;
export type Laycan = z.infer<typeof LaycanSchema>;
export type VoyageSummary = z.infer<typeof VoyageSummarySchema>;
export type VoyageDetail = z.infer<typeof VoyageDetailSchema>;
export type VoyageListResponse = z.infer<typeof VoyageListResponseSchema>;
export type ListVoyagesQuery = z.infer<typeof ListVoyagesQuerySchema>;
export type CreateVoyageRequest = z.infer<typeof CreateVoyageRequestSchema>;
export type VesselListResponse = z.infer<typeof VesselListResponseSchema>;
export type CommodityListResponse = z.infer<typeof CommodityListResponseSchema>;
export type PortListResponse = z.infer<typeof PortListResponseSchema>;
