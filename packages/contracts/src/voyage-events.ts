import { z } from 'zod';
import { apiSchemaRegistry } from './registry.js';

/*
 * Server-sent events of `GET /api/voyages/{voyageId}/events`: signals that something on the
 * voyage changed, so the client should read it again through the REST endpoints. A message
 * carries its type and nothing else (no ids, no contents, no audit payload): the REST reads stay
 * the only source of data and keep applying their own visibility rules.
 *
 * Delivery is best effort. There is no replay: a client that was disconnected has missed what
 * happened meanwhile, and catches up by reading again when the stream says `READY`.
 */

/** Changes the stream signals. Each one is sent only to the two counterparties of its contract. */
export const VOYAGE_CHANGE_TYPES = [
  'NOTICE_ISSUED',
  'NOTICE_ACKNOWLEDGED',
  'DOCUMENTARY_INSTRUCTION_REVISED',
  'DOCUMENTARY_INSTRUCTION_ACKNOWLEDGED',
] as const;

export const VoyageChangeTypeSchema = z.enum(VOYAGE_CHANGE_TYPES);

export const VoyageStreamMessageSchema = z
  .discriminatedUnion('type', [
    /**
     * First message of every connection, sent once the subscription is in place: anything that
     * changes from now on is signalled, so a read made after it misses nothing.
     */
    z.object({ type: z.literal('READY') }),
    z.object({ type: VoyageChangeTypeSchema }),
  ])
  .register(apiSchemaRegistry, {
    id: 'VoyageStreamMessage',
    description:
      'The JSON `data` of one server-sent event: `READY` once connected, then the type of each ' +
      'change. Never the changed data itself.',
  });

export type VoyageChangeType = z.infer<typeof VoyageChangeTypeSchema>;
export type VoyageStreamMessage = z.infer<typeof VoyageStreamMessageSchema>;
