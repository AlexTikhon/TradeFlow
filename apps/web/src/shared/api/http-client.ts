import { type ProblemDetails, ProblemDetailsSchema } from '@tradeflow/contracts';
import type { z } from 'zod';

const API_BASE_PATH = '/api';

/** The server answered with a non-2xx status. Carries the RFC 9457 body when there is one. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly problem: ProblemDetails | null,
  ) {
    super(problem?.detail ?? problem?.title ?? `Request failed with status ${status}`);
    this.name = 'ApiError';
  }
}

/** The server answered 2xx but the body does not match the shared contract. */
export class ApiContractError extends Error {
  constructor(path: string, cause: z.ZodError) {
    super(`Response from ${path} does not match the API contract`, { cause });
    this.name = 'ApiContractError';
  }
}

interface RequestOptions {
  query?: Record<string, string | undefined>;
  signal?: AbortSignal;
}

/**
 * GETs a JSON resource and validates it against its contract schema at the trust boundary,
 * so a frontend/backend version skew fails here with a clear error instead of deep in the UI.
 */
export async function getJson<TSchema extends z.ZodType>(
  path: string,
  schema: TSchema,
  { query, signal }: RequestOptions = {},
): Promise<z.output<TSchema>> {
  const url = new URL(`${API_BASE_PATH}${path}`, window.location.origin);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, value);
  }

  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    ...(signal && { signal }),
  });
  if (!response.ok) {
    throw new ApiError(response.status, await readProblem(response));
  }

  const result = schema.safeParse(await response.json());
  if (!result.success) {
    throw new ApiContractError(path, result.error);
  }
  return result.data;
}

async function readProblem(response: Response): Promise<ProblemDetails | null> {
  try {
    const parsed = ProblemDetailsSchema.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null; // Body was not JSON (e.g. a proxy error page).
  }
}
