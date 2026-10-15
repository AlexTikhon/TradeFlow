import { z } from 'zod';

/**
 * Schemas registered here are published as named components in the OpenAPI document.
 * An explicit registry (rather than Zod's global one) keeps the published surface deliberate.
 */
export const apiSchemaRegistry = z.registry<{ id: string; description?: string }>();
