import type { IncomingHttpHeaders } from 'node:http';
import { fileURLToPath } from 'node:url';

/**
 * Sanitized failure evidence of one deployment mock run. Only bounded log tails of the owned
 * containers and short summaries are written here; never cookies, request headers, signatures,
 * the recovery environment, keys, PDF bodies, database dumps or browser state. CI uploads this
 * directory when `pnpm deploy:verify` fails.
 */
export const DIAGNOSTICS_DIR = fileURLToPath(
  new URL('../.output/deploy/diagnostics/', import.meta.url),
);
export const LOG_SERVICES = ['api', 'edge', 's3'] as const;
/** Written beside the run metadata by the scenario once every step has passed. */
export const PASSED_MARKER = 'scenario-passed';
export const LOG_TAIL_LINES = 300;
const MAX_CHARACTERS = 64 * 1024;

/** The applications' own terminal colors, which `docker compose logs --no-color` keeps. */
const ANSI_COLORS = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const REDACTIONS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[key]'],
  // Header-like `name: value` / `name=value` pairs, plain or quoted (Caddy/Go/Node formats).
  [
    /\b(authorization|proxy-authorization|cookie|set-cookie|x-amz-security-token)(["']?\s*[:=]\s*)(\[[^\]]*\]|"[^"]*"|'[^']*'|[^\r\n,}]*)/gi,
    '$1$2[redacted]',
  ],
  [/\b(X-Amz-Signature|X-Amz-Credential|Signature|Credential)=[^&\s,"'[\]]+/g, '$1=[redacted]'],
  [/(?:__Host-)?tradeflow_session=[^;\s"',]+/g, '[session cookie]'],
  [/(postgres(?:ql)?:\/\/[^:/\s]+:)[^@\s]+@/gi, '$1[redacted]@'],
];

/** Drops whole header maps from structured (JSON) log lines, e.g. Caddy's request objects. */
function withoutHeaders(line: string): string {
  const start = line.indexOf('{');
  if (start < 0) return line;
  try {
    const parsed = JSON.parse(line.slice(start)) as unknown;
    const strip = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(strip);
      if (!value || typeof value !== 'object') return value;
      return Object.fromEntries(
        Object.entries(value).map(([key, inner]) =>
          /^(?:headers|resp_headers|request_headers)$/i.test(key)
            ? [key, '[omitted]']
            : [key, strip(inner)],
        ),
      );
    };
    return line.slice(0, start) + JSON.stringify(strip(parsed));
  } catch {
    return line;
  }
}

/** Removes this run's generated credentials and any credential-shaped values from text. */
export function sanitize(text: string, secrets: readonly string[]): string {
  let output = text.replace(ANSI_COLORS, '').split('\n').map(withoutHeaders).join('\n');
  for (const secret of secrets) if (secret) output = output.replaceAll(secret, '[mock credential]');
  for (const [pattern, replacement] of REDACTIONS) output = output.replace(pattern, replacement);
  return output;
}

/** The last characters of already-sanitized text (sanitize first: a cut must not split a secret). */
export function tail(text: string, limit = MAX_CHARACTERS): string {
  return text.length <= limit
    ? text
    : `[${String(text.length - limit)} earlier characters omitted]\n${text.slice(-limit)}`;
}

/**
 * Status, media type, size and the Problem Details fields of an unexpected API response. No
 * response headers besides the media type, and no body unless it is a short JSON object.
 */
export function describeResponse(response: {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}): string {
  const contentType = response.headers['content-type'] ?? '';
  const summary: Record<string, unknown> = {
    status: response.status,
    contentType,
    bodyBytes: response.body.length,
  };
  if (/json/i.test(contentType) && response.body.length <= 16 * 1024) {
    try {
      const parsed = JSON.parse(response.body.toString()) as Record<string, unknown>;
      for (const field of ['type', 'title', 'detail', 'code'])
        if (typeof parsed[field] === 'string' || typeof parsed[field] === 'number')
          summary[field] = String(parsed[field]).slice(0, 500);
      if (Array.isArray(parsed.errors))
        summary.errors = JSON.stringify(parsed.errors).slice(0, 1000);
    } catch {
      summary.parse = 'not valid JSON';
    }
  }
  return JSON.stringify(summary, null, 2);
}
