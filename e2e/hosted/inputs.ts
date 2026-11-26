import { isIP } from 'node:net';

/*
 * Inputs of the hosted verification (docs/hosted-verification.md). Everything is explicit: no
 * default target, no default or embedded account, no fallback to localhost. The target comes
 * from the command line; credentials only from the environment, so that they never appear in a
 * process listing or shell history as arguments. Validation errors name what is missing or
 * wrong, never a value.
 */

export interface Account {
  email: string;
  password: string;
}

export type AccountKey = 'seller' | 'buyer' | 'outsider';

export type Trust =
  /** The platform's public roots, normal hostname verification. The only trust for hosted targets. */
  | { kind: 'public' }
  /** This run's mock CA (Node) and its CA-verified leaf key (Chromium). Local mock only. */
  | { kind: 'local-mock'; ca: string; spki: string };

export interface HostedInputs {
  mode: 'full' | 'restored';
  /** `https://host[:port]`, nothing else. */
  origin: string;
  /** Where the HTTP-to-HTTPS redirect is expected. */
  httpOrigin: string;
  accounts: Record<AccountKey, Account>;
  trust: Trust;
  /** A new file for the non-secret results (never overwritten). */
  resultsFile: string | undefined;
  /** Restored mode: the results file of the full run whose data was backed up. */
  expectFile: string | undefined;
  /** How long to wait for the operator to confirm the API restart. */
  restartTimeoutMs: number;
}

export class InputError extends Error {}

export const ENVIRONMENT: Record<AccountKey, { email: string; password: string }> = {
  seller: {
    email: 'TRADEFLOW_VERIFY_SELLER_EMAIL',
    password: 'TRADEFLOW_VERIFY_SELLER_PASSWORD',
  },
  buyer: { email: 'TRADEFLOW_VERIFY_BUYER_EMAIL', password: 'TRADEFLOW_VERIFY_BUYER_PASSWORD' },
  outsider: {
    email: 'TRADEFLOW_VERIFY_OUTSIDER_EMAIL',
    password: 'TRADEFLOW_VERIFY_OUTSIDER_PASSWORD',
  },
};

export const USAGE = `Usage: hosted:verify --origin https://<host> [--mode full|restored] [--results <new-file>]
                     [--expect <full-run-results>] [--restart-timeout <minutes>]
                     [--local-mock-trust <file>]   (local mock only)
Credentials, from the environment only: ${Object.values(ENVIRONMENT)
  .flatMap(({ email, password }) => [email, password])
  .join(', ')}`;

const OPTIONS = new Set([
  '--origin',
  '--mode',
  '--results',
  '--expect',
  '--restart-timeout',
  '--local-mock-trust',
]);

function parseArguments(argv: readonly string[]): Map<string, string> {
  const options = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index] ?? '';
    const value = argv[index + 1];
    // Unknown options are refused, so a mistyped one (or a password passed as one) never passes.
    if (!OPTIONS.has(name)) throw new InputError(`Unknown argument at position ${index + 1}`);
    if (value === undefined || value.startsWith('--'))
      throw new InputError(`${name} needs a value`);
    if (options.has(name)) throw new InputError(`${name} is given twice`);
    options.set(name, value);
  }
  return options;
}

function isLocalName(hostname: string): boolean {
  const name = hostname.toLowerCase().replace(/\.$/, '');
  return name === 'localhost' || name.endsWith('.localhost');
}

function parseOrigin(value: string | undefined, local: boolean): URL {
  if (!value) throw new InputError('--origin is required: there is no default target');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InputError('--origin is not a valid URL');
  }
  if (url.protocol !== 'https:') throw new InputError('--origin must use https://');
  if (url.username || url.password) throw new InputError('--origin must not contain credentials');
  if (url.pathname !== '/' || url.search || url.hash)
    throw new InputError('--origin must be an origin only: no path, query or fragment');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (local) {
    if (url.hostname !== 'localhost')
      throw new InputError('--local-mock-trust applies only to https://localhost:<port>');
  } else if (isLocalName(hostname) || isIP(hostname) !== 0) {
    throw new InputError(
      'A hosted --origin needs a DNS name with a publicly trusted certificate (no IP address or ' +
        'localhost); the local mock is verified through hosted:rehearse-mock',
    );
  }
  return url;
}

function parseTrust(text: string): { ca: string; spki: string; httpOrigin: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new InputError('--local-mock-trust is not JSON');
  }
  const { ca, spki, httpOrigin } = (parsed ?? {}) as Record<string, unknown>;
  if (
    typeof ca !== 'string' ||
    !ca.startsWith('-----BEGIN CERTIFICATE-----') ||
    typeof spki !== 'string' ||
    !/^[A-Za-z0-9+/]{43}=$/.test(spki) ||
    typeof httpOrigin !== 'string' ||
    !/^http:\/\/localhost:\d{1,5}$/.test(httpOrigin)
  )
    throw new InputError('--local-mock-trust must hold the mock CA, its leaf SPKI and HTTP origin');
  return { ca, spki, httpOrigin };
}

export function parseInputs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  readText: (path: string) => string,
): HostedInputs {
  const options = parseArguments(argv);
  const trustFile = options.get('--local-mock-trust');
  const origin = parseOrigin(options.get('--origin'), trustFile !== undefined);

  const mode = options.get('--mode') ?? 'full';
  if (mode !== 'full' && mode !== 'restored') throw new InputError('--mode is full or restored');
  const expectFile = options.get('--expect');
  if (mode === 'restored' && !expectFile)
    throw new InputError('--mode restored needs --expect <results file of the full run>');
  if (mode === 'full' && expectFile) throw new InputError('--expect applies to --mode restored');

  const minutes = Number(options.get('--restart-timeout') ?? '15');
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 120)
    throw new InputError('--restart-timeout is a whole number of minutes from 1 to 120');

  const missing = Object.values(ENVIRONMENT)
    .flatMap(({ email, password }) => [email, password])
    .filter((name) => !env[name]);
  if (missing.length) throw new InputError(`Missing environment variables: ${missing.join(', ')}`);
  const accounts = Object.fromEntries(
    (Object.keys(ENVIRONMENT) as AccountKey[]).map((key) => {
      const email = (env[ENVIRONMENT[key].email] ?? '').trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+$/.test(email))
        throw new InputError(`${ENVIRONMENT[key].email} is not an email address`);
      return [key, { email, password: env[ENVIRONMENT[key].password] ?? '' }];
    }),
  ) as Record<AccountKey, Account>;
  if (new Set(Object.values(accounts).map(({ email }) => email)).size !== 3)
    throw new InputError('The seller, buyer and outsider must be three different accounts');

  let trust: Trust = { kind: 'public' };
  let httpOrigin = `http://${origin.hostname}`;
  if (trustFile !== undefined) {
    let text: string;
    try {
      text = readText(trustFile);
    } catch {
      throw new InputError('--local-mock-trust file cannot be read');
    }
    const local = parseTrust(text);
    trust = { kind: 'local-mock', ca: local.ca, spki: local.spki };
    httpOrigin = local.httpOrigin;
  }

  return {
    mode,
    origin: origin.origin,
    httpOrigin,
    accounts,
    trust,
    resultsFile: options.get('--results'),
    expectFile,
    restartTimeoutMs: minutes * 60_000,
  };
}
