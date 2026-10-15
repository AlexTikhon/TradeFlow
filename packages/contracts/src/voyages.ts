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
