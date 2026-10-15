import { z } from 'zod';
import { apiSchemaRegistry } from './registry.js';

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

export const ProblemTypes = {
  /** RFC 9457: no additional semantics beyond the HTTP status code. */
  Generic: 'about:blank',
  ValidationFailed: '/problems/validation-failed',
} as const;

export const ProblemFieldErrorSchema = z.object({
  path: z.string(),
  message: z.string(),
});

/** Error body for every non-2xx response (RFC 9457 Problem Details). */
export const ProblemDetailsSchema = z
  .object({
    type: z.string(),
    title: z.string(),
    status: z.int().min(400).max(599),
    detail: z.string().optional(),
    instance: z.string().optional(),
    errors: z.array(ProblemFieldErrorSchema).optional(),
  })
  .register(apiSchemaRegistry, { id: 'ProblemDetails' });

export type ProblemFieldError = z.infer<typeof ProblemFieldErrorSchema>;
export type ProblemDetails = z.infer<typeof ProblemDetailsSchema>;
