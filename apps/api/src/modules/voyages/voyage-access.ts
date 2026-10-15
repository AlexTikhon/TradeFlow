import type { Prisma } from '../../generated/prisma/client.js';
import type { Principal } from '../auth/principal.js';

/**
 * The single definition of voyage visibility (ADR 0006): an organization may access a voyage
 * if and only if it participates in it. Every voyage query combines this predicate with its own
 * filters using `AND`, so authorization happens inside the database query and no caller-supplied
 * filter can widen it. Anything attached to a voyage (notices, documents, ...) must reach it
 * through this predicate rather than re-stating the rule.
 */
export function accessibleVoyages(principal: Principal): Prisma.VoyageWhereInput {
  return { participants: { some: { organizationId: principal.organizationId } } };
}
