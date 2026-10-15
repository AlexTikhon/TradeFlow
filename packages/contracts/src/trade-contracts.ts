import { z } from 'zod';
import { apiSchemaRegistry } from './registry.js';
import { OrganizationRefSchema } from './voyages.js';

/*
 * Sale contracts as their two counterparties see them. Unlike the shared trade string
 * (ADR 0010), these carry the contract's id, and they are served only to an organization that
 * is the seller or the buyer under the contract (ADR 0011). Other participants never receive
 * them, so nothing here may ever be added to `TradeString`.
 */

export const CONTRACT_SIDES = ['SELLER', 'BUYER'] as const;

export const ContractSideSchema = z.enum(CONTRACT_SIDES).register(apiSchemaRegistry, {
  id: 'ContractSide',
  description: "The signed-in organization's side of the contract.",
});

export const CounterpartyContractSchema = z
  .object({
    id: z.uuid(),
    /** The contract's place in the voyage's trade string (1 is the exporter's sale). */
    position: z.int().min(1),
    side: ContractSideSchema,
    seller: OrganizationRefSchema,
    buyer: OrganizationRefSchema,
  })
  .register(apiSchemaRegistry, {
    id: 'CounterpartyContract',
    description:
      'A sale contract the signed-in organization is a party to, with its id. Served only to ' +
      "the contract's seller and buyer; never part of the shared trade string.",
  });

export const CounterpartyContractListResponseSchema = z
  .object({
    /** In position order. Empty when the organization is not a party to any contract. */
    items: z.array(CounterpartyContractSchema),
  })
  .register(apiSchemaRegistry, { id: 'CounterpartyContractListResponse' });

export type ContractSide = z.infer<typeof ContractSideSchema>;
export type CounterpartyContract = z.infer<typeof CounterpartyContractSchema>;
export type CounterpartyContractListResponse = z.infer<
  typeof CounterpartyContractListResponseSchema
>;
