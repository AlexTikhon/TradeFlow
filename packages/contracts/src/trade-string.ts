import { z } from 'zod';
import { apiSchemaRegistry } from './registry.js';
import { OrganizationRefSchema } from './voyages.js';

/*
 * The trade string as every participant of a voyage may see it (ADR 0010): who sells to whom,
 * in order, and nothing else. Commercial terms and the parties' own contract references are
 * confidential to each contract's two counterparties and are not part of this contract.
 */

/** The participant roles that can be a counterparty in the trade string. */
export const TRADE_ROLES = ['EXPORTER', 'TRADER', 'FINAL_BUYER'] as const;

export const TradeRoleSchema = z.enum(TRADE_ROLES).register(apiSchemaRegistry, {
  id: 'TradeRole',
  description: 'A participant role that can sell or buy in the trade string.',
});

export const TradeStringPartySchema = z
  .object({
    organization: OrganizationRefSchema,
    role: TradeRoleSchema,
  })
  .register(apiSchemaRegistry, { id: 'TradeStringParty' });

export const TradeStringEdgeSchema = z
  .object({
    /** 1 is the exporter's sale; each next position is the previous buyer's sale. */
    position: z.int().min(1),
    sellerOrganizationId: z.uuid(),
    buyerOrganizationId: z.uuid(),
  })
  .register(apiSchemaRegistry, {
    id: 'TradeStringEdge',
    description:
      'One sale contract between adjacent parties, as topology only: who sells to whom, and ' +
      'where in the string. No commercial terms and no contract references.',
  });

export const TradeStringSchema = z
  .object({
    /** In string order: the exporter first, then each trader in turn, the final buyer last. */
    parties: z.array(TradeStringPartySchema),
    /** In position order; edge `n` connects party `n - 1` to party `n`. */
    edges: z.array(TradeStringEdgeSchema),
  })
  .register(apiSchemaRegistry, {
    id: 'TradeString',
    description:
      'The chain of sale contracts from the exporter to the final buyer. Both lists are empty ' +
      'while no contracts are recorded for the voyage.',
  });

/** Fewest and most organizations a trade string set up through the API may name. */
export const TRADE_STRING_MIN_PARTIES = 2;
export const TRADE_STRING_MAX_PARTIES = 10;

/**
 * Body of `POST /api/voyages/{voyageId}/trade-string` (ADR 0016): the organizations the cargo is
 * sold through, in order, the voyage's exporter first. Ids only: roles and positions follow from
 * the order and are decided by the server. Each organization may appear once.
 */
export const ConfigureTradeStringRequestSchema = z
  .strictObject({
    parties: z
      .array(z.strictObject({ organizationId: z.uuid() }))
      .min(TRADE_STRING_MIN_PARTIES, `Name at least ${TRADE_STRING_MIN_PARTIES} organizations`)
      .max(TRADE_STRING_MAX_PARTIES, `Name at most ${TRADE_STRING_MAX_PARTIES} organizations`)
      .superRefine((parties, context) => {
        const seen = new Set<string>();
        parties.forEach(({ organizationId }, index) => {
          if (seen.has(organizationId)) {
            context.addIssue({
              code: 'custom',
              path: [index, 'organizationId'],
              message: 'This organization is already in the trade string',
            });
          }
          seen.add(organizationId);
        });
      }),
  })
  .register(apiSchemaRegistry, {
    id: 'ConfigureTradeStringRequest',
    description:
      "The organizations the cargo is sold through, in order: the voyage's exporter first, then " +
      'each trader, the final buyer last. Each at most once.',
  });

export type ConfigureTradeStringRequest = z.infer<typeof ConfigureTradeStringRequestSchema>;
export type TradeRole = z.infer<typeof TradeRoleSchema>;
export type TradeStringParty = z.infer<typeof TradeStringPartySchema>;
export type TradeStringEdge = z.infer<typeof TradeStringEdgeSchema>;
export type TradeString = z.infer<typeof TradeStringSchema>;
