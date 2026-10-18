import { z } from 'zod';
import { apiSchemaRegistry } from './registry.js';
import { OrganizationRefSchema } from './voyages.js';

/*
 * Finding organizations to name in a voyage's trade string (ADR 0016). Search-only and bounded:
 * a caller must type part of a name, and gets a short page of the same three fields every
 * participant already sees of every other one. Never users, roles, counts or voyages.
 * Organizations are a curated set; nobody creates or edits them through the API.
 */

export const ORGANIZATION_SEARCH_MIN_LENGTH = 2;
export const ORGANIZATION_SEARCH_MAX_LENGTH = 100;
/** Most organizations one search returns. */
export const ORGANIZATION_SEARCH_MAX_RESULTS = 20;

/** Query of `GET /api/organizations`. */
export const OrganizationSearchQuerySchema = z.object({
  /** Part of the name, matched case-insensitively. Surrounding spaces are ignored. */
  search: z
    .string({ error: 'Enter part of an organization name' })
    .trim()
    .min(
      ORGANIZATION_SEARCH_MIN_LENGTH,
      `Enter at least ${ORGANIZATION_SEARCH_MIN_LENGTH} characters`,
    )
    .max(
      ORGANIZATION_SEARCH_MAX_LENGTH,
      `Enter at most ${ORGANIZATION_SEARCH_MAX_LENGTH} characters`,
    ),
});

export const OrganizationSearchResponseSchema = z
  .object({
    /** By name; never the caller's own organization. */
    items: z.array(OrganizationRefSchema).max(ORGANIZATION_SEARCH_MAX_RESULTS),
  })
  .register(apiSchemaRegistry, {
    id: 'OrganizationSearchResponse',
    description: `At most ${ORGANIZATION_SEARCH_MAX_RESULTS} organizations whose name contains the search text, by name.`,
  });

export type OrganizationSearchQuery = z.infer<typeof OrganizationSearchQuerySchema>;
export type OrganizationSearchResponse = z.infer<typeof OrganizationSearchResponseSchema>;
