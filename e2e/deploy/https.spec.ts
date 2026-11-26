import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { chromium, expect, test } from '@playwright/test';
import {
  ContractDocumentSchema,
  CounterpartyContractListResponseSchema,
  DocumentaryInstructionSchema,
} from '@tradeflow/contracts';
import { ANA, DEMO_PASSWORD } from '../demo/accounts.js';
import { signIn } from '../support/app.js';
import { DIAGNOSTICS_DIR, describeResponse, PASSED_MARKER } from './diagnostics.js';

const exec = promisify(execFile);
const metadataFile = process.env.DEPLOY_MOCK_METADATA;
if (!metadataFile) throw new Error('Run with pnpm deploy:verify');
const run = JSON.parse(await readFile(metadataFile, 'utf8')) as {
  baseURL: string;
  httpURL: string;
  project: string;
  ca: string;
  spki: string;
};
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

test('production containers: HTTPS cookies, proxy trust, streamed updates and durable mock data', async () => {
  const docker = async (...args: string[]) =>
    (await exec('docker', args, { windowsHide: true, timeout: 60_000 })).stdout.trim();
  const container = async (service: string) => {
    const id = await docker(
      'ps',
      '--all',
      '--quiet',
      '--filter',
      `label=com.docker.compose.project=${run.project}`,
      '--filter',
      `label=com.docker.compose.service=${service}`,
    );
    if (!/^[a-f0-9]+$/.test(id)) throw new Error('Expected one container owned by this run');
    return id;
  };
  const apiId = await container('api');
  const pgId = await container('postgres');
  const request = (path: string, options: https.RequestOptions = {}, body?: Buffer | string) =>
    new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>(
      (resolve, reject) => {
        const send = https.request(
          new URL(path, run.baseURL),
          { ...options, ca: run.ca, family: 4 },
          (answer) => {
            const chunks: Buffer[] = [];
            answer.on('data', (chunk: Buffer) => chunks.push(chunk));
            answer.on('end', () => {
              resolve({
                status: answer.statusCode ?? 0,
                headers: answer.headers,
                body: Buffer.concat(chunks),
              });
            });
            answer.on('error', reject);
          },
        );
        send.setTimeout(45_000, () => {
          send.destroy(new Error('HTTPS request timed out'));
        });
        send.on('error', reject);
        send.end(body);
      },
    );
  const healthy = async () => {
    await expect
      .poll(async () => (await request('/api/health')).status, { timeout: 30_000 })
      .toBe(200);
  };

  await test.step('trusted TLS, HTTP redirect, immutable assets and no public API/database ports', async () => {
    const root = await request('/');
    expect(root.status).toBe(200);
    expect(root.body.toString()).toContain('<div id="root">');
    const asset = root.body.toString().match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
    expect(asset).toBeDefined();
    expect((await request(asset ?? '')).headers['cache-control']).toContain('immutable');
    expect((await request('/assets/missing-file.js')).status).toBe(404);
    expect((await request('/voyages')).body.toString()).toContain('<div id="root">');
    const missingApi = await request('/api/does-not-exist');
    expect(missingApi.status).toBe(404);
    expect(missingApi.headers['content-type']).toContain('application/problem+json');
    const redirect = await new Promise<{ status: number; location: string | undefined }>(
      (resolve, reject) => {
        http
          .get(new URL('/sign-in?from=mock', run.httpURL), (response) => {
            response.resume();
            resolve({ status: response.statusCode ?? 0, location: response.headers.location });
          })
          .on('error', reject);
      },
    );
    expect(redirect).toEqual({ status: 308, location: `${run.baseURL}/sign-in?from=mock` });
    for (const service of ['api', 'postgres', 's3']) {
      const ports = JSON.parse(
        await docker(
          'inspect',
          '--format',
          '{{json .HostConfig.PortBindings}}',
          await container(service),
        ),
      ) as Record<string, unknown> | null;
      expect(Object.keys(ports ?? {})).toHaveLength(0);
    }
    expect(await docker('exec', apiId, 'id', '-u')).toBe('1000');
    expect(await docker('exec', await container('edge'), 'id', '-u')).toBe('1000');
    // The API trusts the private S3 endpoint only through the mounted mock CA (its
    // NODE_EXTRA_CA_CERTS). Node skips an unreadable CA file with a mere startup warning, so probe
    // the verified handshake itself from the API, as uid 1000, without any explicit `ca`. An
    // anonymous request must reach S3 and be refused there: TLS trusted, bucket still private.
    const objectStore = await docker(
      'exec',
      apiId,
      'node',
      '--input-type=module',
      '-e',
      `
      import https from 'node:https';
      const outcome=await new Promise((resolve)=>{
        https.get('https://objects:9443/tradeflow-mock',res=>{res.resume();resolve(String(res.statusCode));})
          .on('error',error=>resolve(error.message));
      });console.log(outcome);`,
    );
    expect(objectStore, 'API HTTPS request to the private S3 endpoint').toBe('403');
  });

  await test.step('request ids cross the edge and correlate with the API’s own records', async () => {
    const spoofed = 'mock-spoofed-request-id';
    const secret = `mock-secret-${randomBytes(6).toString('hex')}`;
    const traced = await request(`/api/does-not-exist/${secret}?token=${secret}`, {
      headers: { 'X-Request-ID': spoofed, Authorization: `Bearer ${secret}` },
    });
    expect(traced.status).toBe(404);
    const requestId = traced.headers['x-request-id'];
    expect(requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(requestId).not.toBe(spoofed);
    // The API writes the record once the response is handed over: poll its container log.
    let line: string | undefined;
    await expect
      .poll(
        async () => {
          const logs = await docker('logs', '--tail', '500', apiId);
          line = logs.split('\n').find((candidate) => candidate.includes(String(requestId)));
          return line !== undefined;
        },
        { timeout: 10_000 },
      )
      .toBe(true);
    expect(JSON.parse(line ?? '')).toMatchObject({
      event: 'http.request',
      requestId,
      method: 'GET',
      route: 'unmatched',
      status: 404,
      outcome: 'completed',
    });
    const logs = await docker('logs', '--tail', '500', apiId);
    expect(logs).not.toContain(secret);
    expect(logs).not.toContain(spoofed);
  });

  // Trust only this run's verified leaf public key in Chromium; never disable verification globally
  // or modify the user's OS trust store. All Node HTTPS requests verify its real CA chain too.
  const browser = await chromium.launch({
    args: [`--ignore-certificate-errors-spki-list=${run.spki}`],
  });
  const seller = await browser.newContext({ baseURL: run.baseURL, acceptDownloads: true });
  const buyer = await browser.newContext({ baseURL: run.baseURL });
  const sellerPage = await seller.newPage();
  const buyerPage = await buyer.newPage();
  let sellerCookie = '';
  let buyerCookie = '';
  const voyageId = '01990000-0000-7000-8006-000000000001';
  let path = '';
  const bytes = Buffer.concat([Buffer.from('%PDF-1.7\n'), randomBytes(6 * 1024 * 1024)]);
  try {
    await test.step('sign in in a real browser with the production __Host- session cookie', async () => {
      await sellerPage.goto('/sign-in');
      await signIn(sellerPage, ANA);
      await expect(sellerPage.getByRole('button', { name: 'Sign out' })).toBeVisible();
      const cookies = await seller.cookies();
      const cookie = cookies.find((candidate) => candidate.name === '__Host-tradeflow_session');
      expect(cookie).toMatchObject({ secure: true, httpOnly: true, sameSite: 'Strict', path: '/' });
      expect(cookies.some((candidate) => candidate.name === 'tradeflow_session')).toBe(false);
      expect(await sellerPage.evaluate(() => document.cookie)).not.toContain('tradeflow_session');
      sellerCookie = `${cookie?.name ?? ''}=${cookie?.value ?? ''}`;
      const signedIn = await request(
        '/api/auth/sign-in',
        { method: 'POST', headers: { 'Content-Type': 'application/json' } },
        JSON.stringify({ email: 'claire.morel@lacustra.example', password: DEMO_PASSWORD }),
      );
      expect(signedIn.status).toBe(200);
      const header = signedIn.headers['set-cookie']?.[0] ?? '';
      expect(header).toContain('Secure');
      expect(header).not.toMatch(/Domain=/i);
      buyerCookie = header.split(';')[0] ?? '';
      await buyer.addCookies([
        {
          name: '__Host-tradeflow_session',
          value: buyerCookie.slice(buyerCookie.indexOf('=') + 1),
          url: run.baseURL,
          secure: true,
          httpOnly: true,
          sameSite: 'Strict',
        },
      ]);
      await buyerPage.goto(`/voyages/${voyageId}`);
      await expect(
        buyerPage.getByRole('heading', { name: 'TF-2026-0001', exact: true }),
      ).toBeVisible();
    });

    await test.step('SSE arrives through HTTPS without buffering or a REST polling substitute', async () => {
      const contractsResponse = await request(`/api/voyages/${voyageId}/my-contracts`, {
        headers: { Cookie: sellerCookie },
      });
      const contracts = CounterpartyContractListResponseSchema.parse(
        JSON.parse(contractsResponse.body.toString()),
      );
      const contract = contracts.items.find((candidate) => candidate.position === 1);
      expect(contract).toBeDefined();
      path = `/api/voyages/${voyageId}/contracts/${contract?.id ?? ''}/documentary-instructions`;
      await sellerPage.goto(`/voyages/${voyageId}`);
      await sellerPage.evaluate((id) => {
        const state = { ready: false, types: [] as string[] };
        (window as unknown as { mockStream: typeof state }).mockStream = state;
        const source = new EventSource(`/api/voyages/${id}/events`);
        source.onmessage = (event) => {
          const message = JSON.parse(event.data as string) as { type: string };
          state.types.push(message.type);
          if (message.type === 'READY') state.ready = true;
        };
      }, voyageId);
      await expect
        .poll(() =>
          sellerPage.evaluate(
            () => (window as unknown as { mockStream: { ready: boolean } }).mockStream.ready,
          ),
        )
        .toBe(true);
      const instructions = await request(
        path,
        {
          method: 'PUT',
          headers: {
            Cookie: buyerCookie,
            'Content-Type': 'application/json',
            'If-None-Match': '*',
          },
        },
        JSON.stringify({
          consignee: 'AWS mock consignee',
          requirements: [{ document: 'BILL_OF_LADING', originals: 3, copies: 1 }],
        }),
      );
      expect(instructions.status).toBe(201);
      DocumentaryInstructionSchema.parse(JSON.parse(instructions.body.toString()));
      await expect
        .poll(() =>
          sellerPage.evaluate(
            () => (window as unknown as { mockStream: { types: string[] } }).mockStream.types,
          ),
        )
        .toContain('DOCUMENTARY_INSTRUCTION_REVISED');
    });

    await test.step('a multipart-sized document is saved through the private HTTPS S3 endpoint', async () => {
      path += '/revisions/1/documents/BILL_OF_LADING/versions';
      const boundary = 'mock-document';
      const body = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="mock.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
        ),
        bytes,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      const uploaded = await request(
        path,
        {
          method: 'POST',
          headers: {
            Cookie: sellerCookie,
            'If-None-Match': '*',
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': String(body.length),
          },
        },
        body,
      );
      if (uploaded.status !== 201) {
        // The server-side cause is in the API log tail collected at teardown (diagnostics.ts).
        await mkdir(DIAGNOSTICS_DIR, { recursive: true });
        await writeFile(join(DIAGNOSTICS_DIR, 'upload-response.json'), describeResponse(uploaded));
      }
      expect(uploaded.status, `Upload response: ${describeResponse(uploaded)}`).toBe(201);
      expect(
        ContractDocumentSchema.parse(JSON.parse(uploaded.body.toString())).currentVersion.sha256,
      ).toBe(hash(bytes));
      const downloaded = await request(`${path}/1/content`, { headers: { Cookie: buyerCookie } });
      expect(downloaded.status).toBe(200);
      expect(hash(downloaded.body)).toBe(hash(bytes));
      expect((await request(`${path}/1/content`)).status).toBe(401);
    });

    await test.step('API restart preserves sessions, database rows and S3 bytes', async () => {
      await docker('restart', '--timeout', '20', apiId);
      await healthy();
      const downloaded = await request(`${path}/1/content`, { headers: { Cookie: buyerCookie } });
      expect(downloaded.status).toBe(200);
      expect(hash(downloaded.body)).toBe(hash(bytes));
      await sellerPage.reload();
      await expect(sellerPage.getByRole('button', { name: 'Sign out' })).toBeVisible();
    });

    await test.step('database outage separates liveness from readiness and recovers without an API restart', async () => {
      await docker('stop', '--timeout', '10', pgId);
      expect((await request('/api/health/live')).status).toBe(200);
      expect((await request('/api/health')).status).toBe(503);
      await docker('start', pgId);
      await healthy();
      expect(
        hash((await request(`${path}/1/content`, { headers: { Cookie: buyerCookie } })).body),
      ).toBe(hash(bytes));
    });

    await test.step('forged forwarding headers cannot bypass the actual edge sign-in budget', async () => {
      let limited = false;
      for (let index = 1; index <= 21; index++) {
        const response = await request(
          '/api/auth/sign-in',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Forwarded-For': `198.51.100.${index}`,
              'X-Forwarded-Proto': 'http',
              Forwarded: `for=192.0.2.${index}`,
            },
          },
          '{}',
        );
        expect([400, 429]).toContain(response.status);
        if (limited) expect(response.status).toBe(429);
        if (response.status === 429) {
          limited = true;
          expect(response.headers['retry-after']).toBeDefined();
        }
      }
      expect(limited).toBe(true);
      // A genuinely different TCP client through the same edge must still have a fresh budget.
      // This detects accidentally pooling everyone under the edge's own address.
      const otherClient = await docker(
        'exec',
        apiId,
        'node',
        '--input-type=module',
        '-e',
        `
        import https from 'node:https'; import {readFileSync} from 'node:fs';
        const status=await new Promise((resolve,reject)=>{
          const req=https.request({hostname:'edge',port:8443,servername:'localhost',ca:readFileSync('/etc/tradeflow/mock-ca.crt'),method:'POST',path:'/api/auth/sign-in',headers:{Host:'localhost','Content-Type':'application/json','X-Forwarded-For':'198.51.100.1'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});
          req.on('error',reject);req.end('{}');
        });console.log(status);`,
      );
      expect(otherClient).toBe('400');
      const [signedOut] = await Promise.all([
        sellerPage.waitForResponse(
          (response) =>
            response.url().endsWith('/api/auth/sign-out') && response.request().method() === 'POST',
        ),
        sellerPage.getByRole('button', { name: 'Sign out' }).click(),
      ]);
      expect(signedOut.status()).toBe(204);
      await expect(sellerPage.getByRole('form', { name: 'Sign in' })).toBeVisible();
      expect((await request('/api/auth/me', { headers: { Cookie: sellerCookie } })).status).toBe(
        401,
      );
    });
    await writeFile(join(dirname(metadataFile), PASSED_MARKER), '');
  } finally {
    await seller.close();
    await buyer.close();
    await browser.close();
  }
});
