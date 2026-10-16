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

/** No valid session: never signed in, expired, or revoked (for example by signing out elsewhere). */
export const isUnauthenticated = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 401;

interface RequestOptions {
  query?: Record<string, string | undefined>;
  signal?: AbortSignal;
  /** Extra request headers, such as the preconditions of a conditional write (`If-Match`). */
  headers?: Record<string, string>;
}

interface SendOptions extends RequestOptions {
  /** A JSON body. */
  body?: unknown;
  /** A multipart body. The browser sets its Content-Type, boundary included. */
  form?: FormData;
  /** What the response may be; errors are always Problem Details (JSON). */
  accept?: string;
}

/**
 * Sends a request to the API. The session cookie is HttpOnly and same-origin, so the browser
 * attaches it; no code here ever sees the token.
 */
async function send(
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  { query, signal, headers, body, form, accept = 'application/json' }: SendOptions = {},
): Promise<Response> {
  const url = new URL(`${API_BASE_PATH}${path}`, window.location.origin);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, value);
  }

  const response = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: {
      ...headers,
      Accept: accept,
      ...(body !== undefined && { 'Content-Type': 'application/json' }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
    ...(form && { body: form }),
    ...(signal && { signal }),
  });
  if (!response.ok) {
    throw new ApiError(response.status, await readProblem(response));
  }
  return response;
}

/** Validates a body against its contract schema at the trust boundary. */
async function parseBody<TSchema extends z.ZodType>(
  path: string,
  response: Response,
  schema: TSchema,
): Promise<z.output<TSchema>> {
  const result = schema.safeParse(await response.json());
  if (!result.success) {
    throw new ApiContractError(path, result.error);
  }
  return result.data;
}

/**
 * GETs a JSON resource and validates it against its contract schema at the trust boundary,
 * so a frontend/backend version skew fails here with a clear error instead of deep in the UI.
 */
export async function getJson<TSchema extends z.ZodType>(
  path: string,
  schema: TSchema,
  options: RequestOptions = {},
): Promise<z.output<TSchema>> {
  return parseBody(path, await send('GET', path, options), schema);
}

/** POSTs a JSON body and validates the JSON response. */
export async function postJson<TSchema extends z.ZodType>(
  path: string,
  body: unknown,
  schema: TSchema,
  options: RequestOptions = {},
): Promise<z.output<TSchema>> {
  return parseBody(path, await send('POST', path, { ...options, body }), schema);
}

/** PUTs a JSON body (a full replacement or new version) and validates the JSON response. */
export async function putJson<TSchema extends z.ZodType>(
  path: string,
  body: unknown,
  schema: TSchema,
  options: RequestOptions = {},
): Promise<z.output<TSchema>> {
  return parseBody(path, await send('PUT', path, { ...options, body }), schema);
}

/**
 * POSTs one file as `multipart/form-data`, in the form field `field`, and validates the JSON
 * response. The file is streamed by the browser; nothing here reads it.
 */
export async function postFile<TSchema extends z.ZodType>(
  path: string,
  field: string,
  file: File,
  schema: TSchema,
  options: RequestOptions = {},
): Promise<z.output<TSchema>> {
  const form = new FormData();
  form.append(field, file, file.name);
  return parseBody(path, await send('POST', path, { ...options, form }), schema);
}

/** GETs a file's bytes, of the media type `accept`. */
export async function getBlob(
  path: string,
  accept: string,
  options: RequestOptions = {},
): Promise<Blob> {
  const response = await send('GET', path, {
    ...options,
    accept: `${accept}, application/problem+json`,
  });
  return response.blob();
}

/** POSTs without a body, for commands answered with 204 No Content. */
export async function postEmpty(path: string, options: RequestOptions = {}): Promise<void> {
  await send('POST', path, options);
}

async function readProblem(response: Response): Promise<ProblemDetails | null> {
  try {
    const parsed = ProblemDetailsSchema.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null; // Body was not JSON (e.g. a proxy error page).
  }
}
