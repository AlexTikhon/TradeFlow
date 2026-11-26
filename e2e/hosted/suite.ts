import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { type Browser, type BrowserContext, chromium, type Page } from '@playwright/test';
import {
  CommodityListResponseSchema,
  ContractDocumentSchema,
  CounterpartyContractListResponseSchema,
  CurrentUserSchema,
  DocumentListResponseSchema,
  PortListResponseSchema,
  TradeStringSchema,
  VesselListResponseSchema,
  VoyageDetailSchema,
  VoyageTimelinePageSchema,
} from '@tradeflow/contracts';
import type { AccountKey, HostedInputs } from './inputs.js';
import { fictionalPdf } from './pdf.js';

/*
 * Hosted verification of one TradeFlow environment through its public HTTPS origin, as its users
 * reach it: Chromium for the two counterparties (and an outsider), each in its own context,
 * signing in through the form. Each full run creates its own voyage, so it needs neither an
 * empty environment nor a reset. Nothing is persisted from the browsers: no traces, no
 * screenshots, no storage state, no downloads on disk. Results hold identifiers, statuses,
 * timings and hashes, never credentials, cookies or document bytes.
 */

export const RESULTS_FORMAT = 'tradeflow-hosted-verification/1';
export const CHECKPOINT_LINE = 'CHECKPOINT before-restart: passed';

const FULL_CHECKS = [
  'edge.https',
  'edge.http-redirect',
  'api.health',
  'api.request-id',
  'auth.sign-in',
  'auth.production-cookie',
  'edge.same-origin',
  'voyage.create',
  'access.before-participation',
  'trade-string.setup',
  'sse.connected',
  'sse.instruction-delivered',
  'document.upload',
  'document.download',
  'access.documents',
  'restart.checkpoint',
  'restart.stream-reconnected',
  'restart.session',
  'restart.database',
  'restart.document-bytes',
  'restart.sse-delivery',
  'auth.sign-out',
] as const;

const RESTORED_CHECKS = [
  'edge.https',
  'api.health',
  'auth.sign-in',
  'auth.production-cookie',
  'restored.voyage',
  'restored.documents',
  'restored.timeline',
  'auth.sign-out',
] as const;

type Detail = string | number | boolean | null;

export interface CheckResult {
  id: string;
  outcome: 'passed' | 'failed' | 'not-run';
  startedAt?: string;
  durationMs?: number;
  details?: Record<string, Detail>;
  error?: string;
}

/** What a full run created, for the restart checks and for verifying a restore of its data. */
export interface RunRecord {
  voyageId: string;
  voyageReference: string;
  contractId: string;
  contentPath: string;
  sha256: string;
  sizeBytes: number;
  reviewed: boolean;
  timelineActions: string[];
}

export interface Results {
  format: typeof RESULTS_FORMAT;
  mode: HostedInputs['mode'];
  origin: string;
  trust: HostedInputs['trust']['kind'];
  startedAt: string;
  finishedAt: string;
  outcome: 'passed' | 'failed';
  checks: CheckResult[];
  run: RunRecord | null;
  restart: Record<string, Detail> | null;
}

export interface SuiteIo {
  log(line: string): void;
  /** Resolves once the operator confirms the API restart; rejects on timeout or abort. */
  waitForRestart(timeoutMs: number): Promise<void>;
}

const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SESSION_COOKIE = '__Host-tradeflow_session';
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

class Secrets {
  private readonly values = new Set<string>();
  add(value: string | undefined) {
    if (value && value.length >= 4) this.values.add(value);
  }
  redact(text: string): string {
    let output = text;
    for (const value of this.values) output = output.replaceAll(value, '[redacted]');
    return output.replace(/(?:__Host-)?tradeflow_session=[^;\s"',]+/g, '[session cookie]');
  }
}

class CheckFailed extends Error {}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function waitFor<T>(
  probe: () => Promise<T | undefined>,
  timeoutMs: number,
  message: () => string,
): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > until) throw new Error(message());
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

interface NodeResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

/** A request from Node, outside the browser. Public trust unless this is the local mock. */
function nodeRequest(
  inputs: HostedInputs,
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<NodeResponse> {
  const target = new URL(url, inputs.origin);
  const local = inputs.trust.kind === 'local-mock';
  const client = target.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = client.request(
      target,
      {
        method: options.method ?? 'GET',
        headers: options.headers,
        agent: false,
        ...(local && { family: 4 }),
        ...(local && inputs.trust.kind === 'local-mock' && { ca: inputs.trust.ca }),
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size <= 1024 * 1024) chunks.push(chunk);
        });
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          });
        });
        response.on('error', reject);
      },
    );
    request.setTimeout(30_000, () => request.destroy(new Error(`${target.pathname} timed out`)));
    request.on('error', reject);
    request.end(options.body);
  });
}

interface PageResponse {
  status: number;
  requestId: string | null;
  etag: string | null;
  allowOrigin: string | null;
  body: string;
}

/** A same-origin request from the page, with the browser's own cookie handling. */
async function call(
  page: Page,
  method: string,
  path: string,
  init: { json?: unknown; headers?: Record<string, string>; readBody?: boolean } = {},
): Promise<PageResponse> {
  return page.evaluate(
    async ({ method, path, json, headers, readBody }) => {
      const response = await fetch(
        path,
        json === undefined
          ? { method, credentials: 'same-origin', headers }
          : {
              method,
              credentials: 'same-origin',
              headers: { ...headers, 'Content-Type': 'application/json' },
              body: JSON.stringify(json),
            },
      );
      let body = '';
      if (readBody) body = (await response.text()).slice(0, 256 * 1024);
      else await response.body?.cancel();
      return {
        status: response.status,
        requestId: response.headers.get('x-request-id'),
        etag: response.headers.get('etag'),
        allowOrigin: response.headers.get('access-control-allow-origin'),
        body,
      };
    },
    { method, path, json: init.json, headers: init.headers ?? {}, readBody: init.readBody ?? true },
  );
}

function describe(response: { status: number; requestId: string | null; body: string }): string {
  let problem: string;
  try {
    const parsed = JSON.parse(response.body) as Record<string, unknown>;
    problem = [parsed.title, parsed.detail]
      .filter((value): value is string => typeof value === 'string')
      .join(': ')
      .slice(0, 300);
  } catch {
    problem = '';
  }
  return `status ${response.status}, request id ${response.requestId ?? 'none'}${problem ? `, ${problem}` : ''}`;
}

function expectStatus(
  response: { status: number; requestId: string | null; body: string },
  expected: number,
  what: string,
) {
  if (response.status !== expected)
    throw new Error(`${what}: expected ${expected}, got ${describe(response)}`);
}

/** The part of a contract schema used here (Zod's `safeParse`). */
interface Schema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

function parse<T>(schema: Schema<T>, response: PageResponse, what: string): T {
  const result = schema.safeParse(JSON.parse(response.body));
  if (!result.success) throw new Error(`${what}: unexpected response shape`);
  return result.data;
}

/** What the page's own (the web app's) EventSources saw, by connection: times and types only. */
interface StreamLog {
  url: string;
  errors: number[];
  messages: { at: number; type: string | null }[];
}

/**
 * Observes the web app's real EventSource connections. A subclass with extra listeners: the
 * app's own handlers, its reconnection and its polling fallback are unchanged. Only times and
 * message types are kept, in page memory. Plain JavaScript text, because tsx's transform would
 * add helpers to a serialized TypeScript function that do not exist in the page.
 */
const INSTRUMENT_EVENT_SOURCE = `(() => {
  const Native = window.EventSource;
  const connections = [];
  Object.defineProperty(window, '__tradeflowStreams', { value: connections });
  window.EventSource = class extends Native {
    constructor(url, init) {
      super(url, init);
      const entry = { url: String(url), errors: [], messages: [] };
      connections.push(entry);
      this.addEventListener('error', () => entry.errors.push(Date.now()));
      this.addEventListener('message', (event) => {
        let type = null;
        try {
          const data = JSON.parse(String(event.data));
          type = typeof data.type === 'string' ? data.type : null;
        } catch {}
        entry.messages.push({ at: Date.now(), type });
      });
    }
  };
})();`;

function streams(page: Page, voyageId: string): Promise<StreamLog[]> {
  return page.evaluate((path) => {
    const all = (window as unknown as { __tradeflowStreams?: StreamLog[] }).__tradeflowStreams;
    return (all ?? []).filter((entry) => new URL(entry.url, location.origin).pathname === path);
  }, `/api/voyages/${voyageId}/events`);
}

const pageNow = (page: Page) => page.evaluate(() => Date.now());

async function streamMessage(page: Page, voyageId: string, type: string, since: number) {
  return waitFor(
    async () => {
      for (const entry of await streams(page, voyageId))
        for (const message of entry.messages)
          if (message.type === type && message.at >= since) return message.at;
      return undefined;
    },
    30_000,
    () => `No ${type} message arrived on the web app's event stream within 30 s`,
  );
}

interface Digest {
  status: number;
  contentType: string | null;
  disposition: string | null;
  reprDigest: string | null;
  requestId: string | null;
  size: number;
  sha256: string;
}

/** Downloads in the page and hashes there: the bytes never leave the browser's memory. */
function download(page: Page, path: string): Promise<Digest> {
  return page.evaluate(async (path) => {
    const response = await fetch(path, { credentials: 'same-origin' });
    const bytes = await response.arrayBuffer();
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return {
      status: response.status,
      contentType: response.headers.get('content-type'),
      disposition: response.headers.get('content-disposition'),
      reprDigest: response.headers.get('repr-digest'),
      requestId: response.headers.get('x-request-id'),
      size: bytes.byteLength,
      sha256: Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join(''),
    };
  }, path);
}

function expectDocument(digest: Digest, sha: string, size: number, who: string) {
  expectStatus({ ...digest, body: '' }, 200, `${who} download`);
  assert(
    digest.contentType?.startsWith('application/pdf'),
    `${who} download is not application/pdf`,
  );
  assert(digest.disposition?.startsWith('attachment'), `${who} download is not an attachment`);
  assert(
    digest.reprDigest === `sha-256=:${Buffer.from(sha, 'hex').toString('base64')}:`,
    `${who} download's Repr-Digest does not match the uploaded SHA-256`,
  );
  assert(digest.size === size && digest.sha256 === sha, `${who} downloaded different bytes`);
}

async function signInThroughForm(page: Page, email: string, password: string, who: string) {
  await page.goto('/sign-in');
  const form = page.getByRole('form', { name: 'Sign in' });
  await form.getByLabel('Email').fill(email);
  await form.getByLabel('Password').fill(password);
  const [response] = await Promise.all([
    page.waitForResponse(
      (candidate) =>
        new URL(candidate.url()).pathname === '/api/auth/sign-in' &&
        candidate.request().method() === 'POST',
    ),
    form.getByRole('button', { name: 'Sign in' }).click(),
  ]);
  if (response.status() !== 200)
    throw new Error(
      `${who} sign-in answered ${response.status()} (request id ${(await response.headerValue('x-request-id')) ?? 'none'})`,
    );
  await page.getByRole('button', { name: 'Sign out' }).waitFor({ timeout: 20_000 });
}

async function signOutThroughApp(page: Page, who: string) {
  const button = page.getByRole('button', { name: 'Sign out' });
  const [response] = await Promise.all([
    page.waitForResponse(
      (candidate) =>
        new URL(candidate.url()).pathname === '/api/auth/sign-out' &&
        candidate.request().method() === 'POST',
    ),
    button.click(),
  ]);
  assert(response.status() === 204, `${who} sign-out answered ${response.status()}`);
  await page.getByRole('form', { name: 'Sign in' }).waitFor({ timeout: 20_000 });
}

interface Party {
  context: BrowserContext;
  page: Page;
  /** Every URL the page requested, to show that nothing leaves the origin. */
  requested: string[];
  organizationId: string;
}

function readExpectation(text: string): RunRecord {
  const parsed = JSON.parse(text) as Partial<Results>;
  const run = parsed.run;
  if (
    parsed.format !== RESULTS_FORMAT ||
    parsed.mode !== 'full' ||
    parsed.outcome !== 'passed' ||
    !run
  )
    throw new Error('--expect must be the results file of a passed full run');
  return run;
}

export async function runSuite(
  inputs: HostedInputs,
  io: SuiteIo,
  readText: (path: string) => string,
): Promise<Results> {
  const secrets = new Secrets();
  for (const { password } of Object.values(inputs.accounts)) secrets.add(password);
  const planned: readonly string[] = inputs.mode === 'full' ? FULL_CHECKS : RESTORED_CHECKS;
  const checks: CheckResult[] = [];
  const results: Results = {
    format: RESULTS_FORMAT,
    mode: inputs.mode,
    origin: inputs.origin,
    trust: inputs.trust.kind,
    startedAt: new Date().toISOString(),
    finishedAt: '',
    outcome: 'failed',
    checks,
    run: null,
    restart: null,
  };
  const check = async (id: string, body: (details: Record<string, Detail>) => Promise<void>) => {
    assert(planned[checks.length] === id, `Internal: check ${id} out of order`);
    const startedAt = new Date();
    const details: Record<string, Detail> = {};
    io.log(`… ${id}`);
    try {
      await body(details);
      const durationMs = Date.now() - startedAt.getTime();
      checks.push({
        id,
        outcome: 'passed',
        startedAt: startedAt.toISOString(),
        durationMs,
        details,
      });
      io.log(`PASS ${id} (${durationMs} ms)`);
    } catch (error) {
      const message = secrets
        .redact(error instanceof Error ? error.message : 'unknown error')
        .slice(0, 1_500);
      const durationMs = Date.now() - startedAt.getTime();
      checks.push({
        id,
        outcome: 'failed',
        startedAt: startedAt.toISOString(),
        durationMs,
        details,
        error: message,
      });
      io.log(`FAIL ${id}: ${message}`);
      throw new CheckFailed(id);
    }
  };

  const expected = inputs.expectFile ? readExpectation(readText(inputs.expectFile)) : undefined;
  let browser: Browser | undefined;
  const parties = {} as Record<AccountKey, Party>;
  const party = (key: AccountKey) => {
    const found = parties[key] as Party | undefined;
    assert(found, `Internal: ${key} is not signed in`);
    return found;
  };
  const cookieOf = async (key: AccountKey) => {
    const cookie = (await party(key).context.cookies(inputs.origin)).find(
      ({ name }) => name === SESSION_COOKIE,
    );
    secrets.add(cookie?.value);
    return cookie;
  };

  try {
    await check('edge.https', async (details) => {
      const root = await nodeRequest(inputs, '/');
      assert(root.status === 200, `GET / answered ${root.status}`);
      const html = root.body.toString();
      assert(html.includes('<div id="root">'), 'GET / is not the single-page app');
      const asset = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
      assert(asset, 'The app references no hashed script asset');
      const cached = await nodeRequest(inputs, asset);
      assert(cached.status === 200, `The script asset answered ${cached.status}`);
      assert(
        String(cached.headers['cache-control']).includes('immutable'),
        'Hashed assets are not cached as immutable',
      );
      const deepLink = await nodeRequest(inputs, '/voyages');
      assert(
        deepLink.body.toString().includes('<div id="root">'),
        'Deep links do not serve the app',
      );
      const unknown = await nodeRequest(inputs, '/api/does-not-exist');
      assert(
        unknown.status === 404 &&
          String(unknown.headers['content-type']).includes('application/problem+json'),
        'Unknown API paths do not answer 404 Problem Details',
      );
      details.trust = inputs.trust.kind;
    });

    if (inputs.mode === 'full')
      await check('edge.http-redirect', async (details) => {
        const response = await nodeRequest(inputs, `${inputs.httpOrigin}/sign-in?from=verify`);
        assert(
          response.status === 308 &&
            response.headers.location === `${inputs.origin}/sign-in?from=verify`,
          `HTTP answered ${response.status} to ${String(response.headers.location)}, not 308 to the HTTPS origin`,
        );
        details.status = response.status;
      });

    await check('api.health', async () => {
      const ready = await nodeRequest(inputs, '/api/health');
      const live = await nodeRequest(inputs, '/api/health/live');
      assert(ready.status === 200, `Readiness answered ${ready.status}`);
      assert(live.status === 200, `Liveness answered ${live.status}`);
    });

    if (inputs.mode === 'full')
      await check('api.request-id', async (details) => {
        const spoofed = `verify-spoofed-${randomUUID()}`;
        const response = await nodeRequest(inputs, '/api/does-not-exist', {
          headers: { 'X-Request-ID': spoofed },
        });
        const id = response.headers['x-request-id'];
        assert(typeof id === 'string' && REQUEST_ID.test(id), 'No server-generated X-Request-ID');
        assert(id !== spoofed, 'The client-supplied X-Request-ID was kept');
        // The operator can find exactly this record in the API's log (docs/hosted-verification.md).
        details.requestId = id;
      });

    await check('auth.sign-in', async () => {
      browser = await chromium.launch({
        args:
          inputs.trust.kind === 'local-mock'
            ? [`--ignore-certificate-errors-spki-list=${inputs.trust.spki}`]
            : [],
      });
      for (const key of ['seller', 'buyer', 'outsider'] as const) {
        const context = await browser.newContext({
          baseURL: inputs.origin,
          acceptDownloads: false,
        });
        await context.addInitScript({ content: INSTRUMENT_EVENT_SOURCE });
        const page = await context.newPage();
        const requested: string[] = [];
        page.on('request', (request) => requested.push(request.url()));
        const { email, password } = inputs.accounts[key];
        await signInThroughForm(page, email, password, key);
        parties[key] = { context, page, requested, organizationId: '' };
      }
    });

    await check('auth.production-cookie', async (details) => {
      const hostname = new URL(inputs.origin).hostname;
      for (const key of ['seller', 'buyer', 'outsider'] as const) {
        const cookies = await party(key).context.cookies(inputs.origin);
        const session = await cookieOf(key);
        assert(session, `${key}: no ${SESSION_COOKIE} cookie`);
        assert(
          session.secure &&
            session.httpOnly &&
            session.sameSite === 'Strict' &&
            session.path === '/',
          `${key}: the session cookie is not Secure, HttpOnly, SameSite=Strict, Path=/`,
        );
        assert(session.domain === hostname, `${key}: the session cookie is not host-only`);
        assert(
          !cookies.some(({ name }) => name === 'tradeflow_session'),
          `${key}: a non-prefixed session cookie exists`,
        );
        assert(
          !(await party(key).page.evaluate(() => document.cookie)).includes('tradeflow_session'),
          `${key}: page script can read the session cookie`,
        );
        const me = await call(party(key).page, 'GET', '/api/auth/me');
        expectStatus(me, 200, `${key} /api/auth/me`);
        party(key).organizationId = parse(CurrentUserSchema, me, 'me').organization.id;
      }
      const organizations = new Set(
        (['seller', 'buyer', 'outsider'] as const).map((key) => party(key).organizationId),
      );
      assert(organizations.size === 3, 'The three accounts must belong to three organizations');
      details.cookie = SESSION_COOKIE;
    });

    if (inputs.mode === 'full') {
      let voyageId = '';
      let reference = '';
      let contractId = '';
      let instructionsPath = '';
      let documentPath = '';
      let contentPath = '';
      let documentVersion = 0;
      const pdf = fictionalPdf(`Run ${new Date().toISOString()}`, 6 * 1024 * 1024);
      const pdfSha = sha256(pdf);

      await check('edge.same-origin', async (details) => {
        const seller = party('seller');
        const foreign = seller.requested.filter((url) => {
          if (!/^https?:/.test(url)) return false;
          return new URL(url).origin !== inputs.origin;
        });
        assert(foreign.length === 0, `The app requested ${foreign.length} other-origin URL(s)`);
        const cookie = await cookieOf('seller');
        const cookieHeader = `${SESSION_COOKIE}=${cookie?.value ?? ''}`;
        // A cross-site write, signed in: refused by the API before validation (ADR 0007).
        const crossSite = await nodeRequest(inputs, '/api/voyages', {
          method: 'POST',
          headers: {
            Cookie: cookieHeader,
            'Content-Type': 'application/json',
            Origin: 'https://cross-site.invalid',
            'Sec-Fetch-Site': 'cross-site',
          },
          body: '{}',
        });
        assert(
          crossSite.status === 403,
          `A cross-site write answered ${crossSite.status}, not 403`,
        );
        const read = await nodeRequest(inputs, '/api/auth/me', {
          headers: { Cookie: cookieHeader, Origin: 'https://cross-site.invalid' },
        });
        assert(read.status === 200, `/api/auth/me answered ${read.status}`);
        assert(
          read.headers['access-control-allow-origin'] === undefined &&
            read.headers['access-control-allow-credentials'] === undefined,
          'The API grants cross-origin reads (CORS headers present)',
        );
        details.appRequests = seller.requested.length;
      });

      await check('voyage.create', async (details) => {
        const seller = party('seller').page;
        const vessels = parse(
          VesselListResponseSchema,
          await call(seller, 'GET', '/api/vessels'),
          'vessels',
        ).items;
        const commodities = parse(
          CommodityListResponseSchema,
          await call(seller, 'GET', '/api/commodities'),
          'commodities',
        ).items;
        const ports = parse(
          PortListResponseSchema,
          await call(seller, 'GET', '/api/ports'),
          'ports',
        ).items;
        const vessel = vessels.find(({ imoNumber }) => imoNumber === '9400007') ?? vessels[0];
        const commodity = commodities.find(({ code }) => code === 'SOYBEANS') ?? commodities[0];
        const load = ports.find(({ unLocode }) => unLocode === 'BRSSZ') ?? ports[0];
        const discharge =
          ports.find(({ unLocode }) => unLocode === 'NLRTM' && unLocode !== load?.unLocode) ??
          ports.find(({ id }) => id !== load?.id);
        assert(
          vessel && commodity && load && discharge,
          'Reference data is missing (prepare fixtures first)',
        );
        const day = (offset: number) =>
          new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
        const created = await call(seller, 'POST', '/api/voyages', {
          json: {
            vesselId: vessel.id,
            commodityId: commodity.id,
            quantity: { amount: '1000', unit: 'MT' },
            loadPortId: load.id,
            dischargePortId: discharge.id,
            laycan: { start: day(30), end: day(40) },
          },
        });
        expectStatus(created, 201, 'Voyage creation');
        const voyage = parse(VoyageDetailSchema, created, 'voyage');
        voyageId = voyage.id;
        reference = voyage.reference;
        details.voyageId = voyageId;
        details.voyageReference = reference;
        details.requestId = created.requestId;
      });

      await check('access.before-participation', async () => {
        const baseline = await call(party('buyer').page, 'GET', `/api/voyages/${randomUUID()}`);
        expectStatus(baseline, 404, 'A missing voyage');
        const shape = (body: string) => {
          const { type, title, status, detail } = JSON.parse(body) as Record<string, unknown>;
          return JSON.stringify({ type, title, status, detail });
        };
        for (const key of ['buyer', 'outsider'] as const) {
          const page = party(key).page;
          const voyage = await call(page, 'GET', `/api/voyages/${voyageId}`);
          expectStatus(voyage, 404, `${key} reading a voyage it does not take part in`);
          assert(
            shape(voyage.body) === shape(baseline.body),
            `${key}: a non-participant's answer differs from a missing voyage's`,
          );
          const stream = await call(page, 'GET', `/api/voyages/${voyageId}/events`, {
            readBody: false,
          });
          assert(
            stream.status === 404,
            `${key}: the event stream answered ${stream.status}, not 404`,
          );
        }
      });

      await check('trade-string.setup', async (details) => {
        const configured = await call(
          party('seller').page,
          'POST',
          `/api/voyages/${voyageId}/trade-string`,
          {
            json: {
              parties: [
                { organizationId: party('seller').organizationId },
                { organizationId: party('buyer').organizationId },
              ],
            },
          },
        );
        expectStatus(configured, 200, 'Trade string setup');
        assert(
          parse(TradeStringSchema, configured, 'trade string').edges.length === 1,
          'Not one contract',
        );
        const contracts = await call(
          party('buyer').page,
          'GET',
          `/api/voyages/${voyageId}/my-contracts`,
        );
        expectStatus(contracts, 200, 'The buyer reading its contracts');
        const contract = parse(
          CounterpartyContractListResponseSchema,
          contracts,
          'contracts',
        ).items.find(({ position }) => position === 1);
        assert(contract, 'The buyer sees no contract at position 1');
        contractId = contract.id;
        instructionsPath = `/api/voyages/${voyageId}/contracts/${contractId}/documentary-instructions`;
        documentPath = `${instructionsPath}/revisions/1/documents/BILL_OF_LADING`;
        contentPath = `${documentPath}/versions/1/content`;
        details.contractId = contractId;
      });

      await check('sse.connected', async () => {
        for (const key of ['seller', 'buyer'] as const) {
          const page = party(key).page;
          await page.goto(`/voyages/${voyageId}`);
          await page
            .getByRole('heading', { name: reference, exact: true })
            .waitFor({ timeout: 20_000 });
          await streamMessage(page, voyageId, 'READY', 0);
        }
      });

      await check('sse.instruction-delivered', async (details) => {
        const since = await pageNow(party('seller').page);
        const given = await call(party('buyer').page, 'PUT', instructionsPath, {
          headers: { 'If-None-Match': '*' },
          json: {
            consignee: 'Verification consignee (fictional)',
            requirements: [{ document: 'BILL_OF_LADING', originals: 3, copies: 1 }],
          },
        });
        expectStatus(given, 201, 'Giving documentary instructions');
        const at = await streamMessage(
          party('seller').page,
          voyageId,
          'DOCUMENTARY_INSTRUCTION_REVISED',
          since,
        );
        details.deliveredMs = at - since;
      });

      await check('document.upload', async (details) => {
        const since = await pageNow(party('buyer').page);
        const uploaded = await party('seller').page.evaluate(
          async ({ path, base64 }) => {
            const binary = atob(base64);
            const bytes = new Uint8Array(binary.length);
            for (let index = 0; index < binary.length; index++)
              bytes[index] = binary.charCodeAt(index);
            const form = new FormData();
            form.append(
              'file',
              new Blob([bytes], { type: 'application/pdf' }),
              'verification-bill-of-lading.pdf',
            );
            const response = await fetch(path, {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'If-None-Match': '*' },
              body: form,
            });
            return {
              status: response.status,
              requestId: response.headers.get('x-request-id'),
              etag: response.headers.get('etag'),
              allowOrigin: null,
              body: (await response.text()).slice(0, 256 * 1024),
            };
          },
          { path: `${documentPath}/versions`, base64: pdf.toString('base64') },
        );
        expectStatus(uploaded, 201, 'Upload');
        const document = parse(ContractDocumentSchema, uploaded, 'document');
        assert(
          document.currentVersion.sha256 === pdfSha,
          'The server recorded a different SHA-256',
        );
        assert(
          document.currentVersion.sizeBytes === pdf.length,
          'The server recorded a different size',
        );
        documentVersion = document.version;
        const at = await streamMessage(
          party('buyer').page,
          voyageId,
          'DOCUMENT_VERSION_UPLOADED',
          since,
        );
        details.sizeBytes = pdf.length;
        details.sha256 = pdfSha;
        details.requestId = uploaded.requestId;
        details.deliveredMs = at - since;
      });

      await check('document.download', async (details) => {
        for (const key of ['buyer', 'seller'] as const) {
          const digest = await download(party(key).page, contentPath);
          expectDocument(digest, pdfSha, pdf.length, key);
          details[`${key}RequestId`] = digest.requestId;
        }
      });

      await check('access.documents', async () => {
        const outsider = party('outsider').page;
        const content = await download(outsider, contentPath);
        assert(
          content.status === 404,
          `The outsider's download answered ${content.status}, not 404`,
        );
        const list = await call(outsider, 'GET', `/api/voyages/${voyageId}/documents`);
        expectStatus(list, 404, "The outsider reading the voyage's documents");
        const anonymous = await nodeRequest(inputs, contentPath);
        assert(
          anonymous.status === 401,
          `An anonymous download answered ${anonymous.status}, not 401`,
        );
      });

      const before: Record<string, string> = {};
      const checkpointAt: Record<'seller' | 'buyer', number> = { seller: 0, buyer: 0 };
      const snapshot = async () => {
        const seller = party('seller').page;
        const buyer = party('buyer').page;
        const voyage = parse(
          VoyageDetailSchema,
          await call(seller, 'GET', `/api/voyages/${voyageId}`),
          'voyage',
        );
        const documents = parse(
          DocumentListResponseSchema,
          await call(buyer, 'GET', `/api/voyages/${voyageId}/documents`),
          'documents',
        ).items.map(({ id, version, currentVersion }) => ({
          id,
          version,
          number: currentVersion.number,
          sha256: currentVersion.sha256,
          sizeBytes: currentVersion.sizeBytes,
        }));
        const instructions = await call(buyer, 'GET', instructionsPath);
        expectStatus(instructions, 200, 'Reading the documentary instructions');
        const timeline = parse(
          VoyageTimelinePageSchema,
          await call(seller, 'GET', `/api/voyages/${voyageId}/timeline?limit=50`),
          'timeline',
        ).items.map(({ action }) => action);
        return {
          voyage: JSON.stringify({
            id: voyage.id,
            reference: voyage.reference,
            status: voyage.status,
            participants: voyage.participants.length,
          }),
          documents: JSON.stringify(documents),
          instructions: instructions.etag ?? '',
          timeline: JSON.stringify(timeline),
        };
      };

      await check('restart.checkpoint', async (details) => {
        Object.assign(before, await snapshot());
        for (const key of ['seller', 'buyer', 'outsider'] as const)
          before[`cookie:${key}`] = (await cookieOf(key))?.value ?? '';
        checkpointAt.seller = await pageNow(party('seller').page);
        checkpointAt.buyer = await pageNow(party('buyer').page);
        details.checkpointAt = new Date().toISOString();
        io.log(CHECKPOINT_LINE);
        io.log(
          'Restart the API now, outside this suite, with the command for the exact instance and ' +
            'service (docs/hosted-verification.md#restart). Then type "restarted" and Enter.',
        );
        await io.waitForRestart(inputs.restartTimeoutMs);
        details.confirmedAt = new Date().toISOString();
      });

      await check('restart.stream-reconnected', async (details) => {
        for (const key of ['seller', 'buyer'] as const) {
          const page = party(key).page;
          const { dropped, reconnected } = await waitFor(
            async () => {
              const logs = await streams(page, voyageId);
              const dropped = Math.min(
                ...logs.flatMap(({ errors }) => errors.filter((at) => at > checkpointAt[key])),
              );
              if (!Number.isFinite(dropped)) return undefined;
              const reconnected = Math.min(
                ...logs.flatMap(({ messages }) =>
                  messages
                    .filter(({ type, at }) => type === 'READY' && at > dropped)
                    .map(({ at }) => at),
                ),
              );
              return Number.isFinite(reconnected) ? { dropped, reconnected } : undefined;
            },
            180_000,
            () =>
              `${key}: the web app's event stream did not drop and reconnect after the checkpoint ` +
              'within 3 minutes (was the API process restarted?)',
          );
          details[`${key}DroppedAfterCheckpointMs`] = dropped - checkpointAt[key];
          details[`${key}ReconnectedAfterDropMs`] = reconnected - dropped;
        }
        results.restart = { ...details };
      });

      await check('restart.session', async () => {
        for (const key of ['seller', 'buyer', 'outsider'] as const) {
          const cookie = await cookieOf(key);
          assert(cookie?.value === before[`cookie:${key}`], `${key}: the session cookie changed`);
          expectStatus(
            await call(party(key).page, 'GET', '/api/auth/me'),
            200,
            `${key} session after restart`,
          );
        }
        const seller = party('seller').page;
        await seller.reload();
        await seller.getByRole('button', { name: 'Sign out' }).waitFor({ timeout: 20_000 });
        await streamMessage(seller, voyageId, 'READY', (await pageNow(seller)) - 1);
      });

      await check('restart.database', async () => {
        const after = await snapshot();
        for (const field of ['voyage', 'documents', 'instructions', 'timeline'] as const)
          assert(
            after[field] === before[field],
            `The ${field} read after the restart differ from before`,
          );
      });

      await check('restart.document-bytes', async () => {
        expectDocument(
          await download(party('buyer').page, contentPath),
          pdfSha,
          pdf.length,
          'buyer',
        );
      });

      await check('restart.sse-delivery', async (details) => {
        const since = await pageNow(party('seller').page);
        const reviewed = await call(
          party('buyer').page,
          'POST',
          `${documentPath}/versions/1/review`,
          {
            headers: { 'If-Match': `"${documentVersion}"` },
            json: { decision: 'APPROVED' },
          },
        );
        expectStatus(reviewed, 200, 'Approving the document after the restart');
        const at = await streamMessage(
          party('seller').page,
          voyageId,
          'DOCUMENT_VERSION_REVIEWED',
          since,
        );
        details.deliveredMs = at - since;
        const timeline = parse(
          VoyageTimelinePageSchema,
          await call(party('seller').page, 'GET', `/api/voyages/${voyageId}/timeline?limit=50`),
          'timeline',
        ).items.map(({ action }) => action);
        results.run = {
          voyageId,
          voyageReference: reference,
          contractId,
          contentPath,
          sha256: pdfSha,
          sizeBytes: pdf.length,
          reviewed: true,
          timelineActions: timeline,
        };
      });
    } else {
      const run = expected;
      assert(run, 'Internal: no expectation');
      await check('restored.voyage', async (details) => {
        const voyage = await call(party('seller').page, 'GET', `/api/voyages/${run.voyageId}`);
        expectStatus(voyage, 200, 'The seller reading the restored voyage');
        assert(
          parse(VoyageDetailSchema, voyage, 'voyage').reference === run.voyageReference,
          'The restored voyage has another reference',
        );
        expectStatus(
          await call(party('buyer').page, 'GET', `/api/voyages/${run.voyageId}`),
          200,
          'The buyer reading the restored voyage',
        );
        expectStatus(
          await call(party('outsider').page, 'GET', `/api/voyages/${run.voyageId}`),
          404,
          'The outsider reading the restored voyage',
        );
        details.voyageReference = run.voyageReference;
      });
      await check('restored.documents', async (details) => {
        for (const key of ['buyer', 'seller'] as const) {
          const digest = await download(party(key).page, run.contentPath);
          expectDocument(digest, run.sha256, run.sizeBytes, key);
          details[`${key}RequestId`] = digest.requestId;
        }
        const documents = parse(
          DocumentListResponseSchema,
          await call(party('buyer').page, 'GET', `/api/voyages/${run.voyageId}/documents`),
          'documents',
        ).items;
        const current = documents.find(
          ({ currentVersion }) => currentVersion.sha256 === run.sha256,
        );
        assert(current, 'The restored document metadata has no version with the uploaded SHA-256');
        assert(
          (current.currentVersion.review?.decision === 'APPROVED') === run.reviewed,
          'The restored review decision differs',
        );
        expectStatus(
          await call(party('outsider').page, 'GET', `/api/voyages/${run.voyageId}/documents`),
          404,
          'The outsider reading the restored documents',
        );
      });
      await check('restored.timeline', async () => {
        const timeline = parse(
          VoyageTimelinePageSchema,
          await call(party('seller').page, 'GET', `/api/voyages/${run.voyageId}/timeline?limit=50`),
          'timeline',
        ).items.map(({ action }) => action);
        assert(
          JSON.stringify(timeline) === JSON.stringify(run.timelineActions),
          'The restored timeline differs from the backed-up run',
        );
      });
    }

    await check('auth.sign-out', async () => {
      for (const key of ['seller', 'buyer', 'outsider'] as const) {
        const cookie = await cookieOf(key);
        await signOutThroughApp(party(key).page, key);
        const replay = await nodeRequest(inputs, '/api/auth/me', {
          headers: { Cookie: `${SESSION_COOKIE}=${cookie?.value ?? ''}` },
        });
        assert(
          replay.status === 401,
          `${key}: the signed-out session still answered ${replay.status}`,
        );
      }
    });
    results.outcome = 'passed';
  } catch (error) {
    if (!(error instanceof CheckFailed)) {
      const message = secrets.redact(error instanceof Error ? error.message : 'unknown error');
      io.log(`FAIL (outside a check): ${message.slice(0, 1_500)}`);
    }
  } finally {
    for (const { context } of Object.values(parties)) await context.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    for (const id of planned.slice(checks.length)) checks.push({ id, outcome: 'not-run' });
    results.finishedAt = new Date().toISOString();
  }
  return results;
}
