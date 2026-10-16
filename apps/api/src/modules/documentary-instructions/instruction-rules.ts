import type { DocumentaryInstructionContent, DocumentRequirement } from '@tradeflow/contracts';

/*
 * MVP business rules for documentary instructions (ADR 0012). Pure functions; the service and
 * the database enforce who may act and when.
 *
 * - One instruction per sale contract. The buyer gives it and revises it; the seller
 *   acknowledges receipt of a specific revision.
 * - A revision is the whole content (consignee, optional notify party, one to eight document
 *   requirements), never a patch, and never changes once written.
 * - A revision must change something: sending the current content again would only reset the
 *   seller's acknowledgement.
 * - A new revision starts unacknowledged; acknowledgements of earlier revisions remain.
 */

/** Content as stored: an absent notify party is null. */
export interface StoredContent {
  consignee: string;
  notifyParty: string | null;
  requirements: readonly DocumentRequirement[];
}

const canonical = ({ consignee, notifyParty, requirements }: StoredContent) =>
  JSON.stringify([
    consignee,
    notifyParty,
    requirements.map(({ document, originals, copies }) => [document, originals, copies]),
  ]);

/** The content of `request` as it would be stored. */
export const toStoredContent = (request: DocumentaryInstructionContent): StoredContent => ({
  consignee: request.consignee,
  notifyParty: request.notifyParty ?? null,
  requirements: request.requirements,
});

/**
 * Whether two revisions say the same thing. The order of the requirements counts: it is how
 * the buyer chose to list them.
 */
export const sameContent = (a: StoredContent, b: StoredContent): boolean =>
  canonical(a) === canonical(b);
