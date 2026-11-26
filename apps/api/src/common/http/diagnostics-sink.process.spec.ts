import { type ChildProcess, spawn } from 'node:child_process';
import { Agent, request } from 'node:http';
import { fileURLToPath } from 'node:url';
import type { Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  SinkProbeMessage,
  SinkProbeState,
} from '../../../test/support/diagnostics-sink-server.js';
import { MAX_BUFFERED_BYTES } from './diagnostics-sink.js';
import { type HttpRequestRecord, REQUEST_ID_HEADER } from './http-diagnostics.js';

/*
 * The production sink on a real pipe: a child process runs the production HttpDiagnosticsModule
 * behind a node:http server (test/support/diagnostics-sink-server.ts), its standard output is a
 * pipe this test reads, stops reading or closes, and real HTTP requests make it write records.
 */

const API_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const SERVER = fileURLToPath(
  new URL('../../../test/support/diagnostics-sink-server.ts', import.meta.url),
);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RECORD_FIELDS = [
  'durationMs',
  'event',
  'level',
  'method',
  'outcome',
  'requestId',
  'route',
  'status',
  'timestamp',
];
/** No record is shorter than this: its fixed fields and a UUID alone take more. */
const MIN_RECORD_BYTES = 150;

const children: ChildProcess[] = [];
const agents: Agent[] = [];
const running = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;

// Every probe is reaped, whatever the test did: SIGTERM, then SIGKILL after 5 s.
afterEach(async () => {
  for (const agent of agents.splice(0)) agent.destroy();
  await Promise.all(
    children.splice(0).map(async (child) => {
      if (!running(child)) return;
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await Promise.race([exited, sleep(5_000, undefined, { ref: false })]);
      if (running(child)) child.kill('SIGKILL');
    }),
  );
});

interface Probe {
  child: ChildProcess;
  stdout: Readable;
  /** Every request made to it, records or not. */
  requests: () => number;
  get: (path: string) => Promise<{ status: number; requestId: string; body: string }>;
  state: () => Promise<SinkProbeState>;
  shutDown: () => Promise<{ state: SinkProbeState; code: number | null }>;
}

async function startProbe(): Promise<Probe> {
  const child = spawn(process.execPath, ['--import', 'tsx', SERVER], {
    cwd: API_ROOT,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  children.push(child);
  let stderr = '';
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  const port = await new Promise<number>((resolve, reject) => {
    const failed = () => {
      reject(new Error(`Probe exited before listening: ${stderr}`));
    };
    child.once('exit', failed);
    child.once('message', (message: SinkProbeMessage) => {
      child.off('exit', failed);
      if (message.type === 'listening') resolve(message.port);
    });
  });
  const agent = new Agent({ keepAlive: true, maxSockets: 16 });
  agents.push(agent);
  let requests = 0;
  const get: Probe['get'] = (path) => {
    requests += 1;
    return new Promise((resolve, reject) => {
      request({ host: '127.0.0.1', port, path, agent }, (response) => {
        let body = '';
        response.setEncoding('utf8').on('data', (chunk: string) => (body += chunk));
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            requestId: String(response.headers[REQUEST_ID_HEADER.toLowerCase()]),
            body,
          });
        });
      })
        .on('error', reject)
        .end();
    });
  };
  const state = async () => JSON.parse((await get('/state')).body) as SinkProbeState;
  const shutDown = async () => {
    const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
    const closed = new Promise<SinkProbeState>((resolve) => {
      child.on('message', (message: SinkProbeMessage) => {
        if (message.type === 'closed') resolve(message.state);
      });
    });
    child.send('shutdown');
    return { state: await closed, code: await exited };
  };
  return {
    child,
    stdout: child.stdout as Readable,
    requests: () => requests,
    get,
    state,
    shutDown,
  };
}

/** The complete lines read from `stdout` from now on (it flows again, even if paused). */
function readLines(stdout: Readable) {
  const lines: string[] = [];
  let partial = '';
  stdout.setEncoding('utf8').on('data', (chunk: string) => {
    const parts = (partial + chunk).split('\n');
    partial = parts.pop() ?? '';
    lines.push(...parts);
  });
  stdout.resume();
  return { lines, partial: () => partial };
}

async function until(check: () => boolean | Promise<boolean>, what: string, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${what}`);
    await sleep(10);
  }
}

describe('StreamSink on a real standard output pipe', () => {
  it('keeps serving, alive, after the reader of its standard output goes away', async () => {
    const probe = await startProbe();
    const output = readLines(probe.stdout);
    const first = await probe.get('/first');
    expect(first.status).toBe(200);
    await until(() => output.lines.length === 1, 'first record');
    expect((JSON.parse(output.lines[0] ?? '') as HttpRequestRecord).requestId).toBe(
      first.requestId,
    );

    // The read end of the pipe closes: the next write fails with EPIPE (asynchronously on
    // POSIX), which used to be an uncaught exception that ended the process with code 1.
    probe.stdout.destroy();
    for (let i = 0; i < 20; i += 1) expect((await probe.get('/after-close')).status).toBe(200);
    await until(async () => (await probe.state()).state === 'failed', 'sink failed');

    const after = await probe.get('/still-there');
    expect(after).toEqual({
      status: 200,
      requestId: expect.stringMatching(UUID) as string,
      body: 'ok',
    });
    expect(after.requestId).not.toBe(first.requestId);
    expect(probe.child.exitCode).toBeNull();
    expect(probe.child.signalCode).toBeNull();

    const { state, code } = await probe.shutDown();
    expect(code).toBe(0);
    expect(state.state).toBe('closed');
    expect(state.droppedRecords).toBeGreaterThan(0);
    expect(state.stdoutListeners).toEqual({ error: 0, close: 0, drain: 0 });
  }, 60_000);

  // Node writes to a Windows pipe synchronously: a stalled reader stalls the whole process there,
  // whatever the writer does (docs/architecture.md, "HTTP diagnostics").
  it.skipIf(process.platform === 'win32')(
    'stays bounded and serving while its reader stops reading, and recovers when it resumes',
    async () => {
      const probe = await startProbe();
      probe.stdout.pause();
      const ids = new Set<string>();
      let sent = 0;
      const burst = async (upTo: number) => {
        await Promise.all(
          Array.from({ length: 16 }, async () => {
            while (sent < upTo) {
              sent += 1;
              const answer = await probe.get('/burst');
              expect(answer.status).toBe(200);
              expect(answer.body).toBe('ok');
              ids.add(answer.requestId);
            }
          }),
        );
      };

      // Far more record bytes than the pipe, the reader's buffer and the sink's bound hold. The
      // sink stops at its byte bound or at the pipe's backpressure, whichever comes first
      // (the bound, on Node 24's 64 KiB Linux pipes); either way it drops what does not fit.
      await burst(3_000);
      const stalled = await probe.state();
      expect(['open', 'blocked']).toContain(stalled.state);
      expect(stalled.droppedRecords * MIN_RECORD_BYTES).toBeGreaterThan(MAX_BUFFERED_BYTES);
      expect(stalled.bufferedBytes).toBeGreaterThan(MAX_BUFFERED_BYTES / 2);
      expect(stalled.bufferedBytes).toBeLessThanOrEqual(MAX_BUFFERED_BYTES);
      expect(stalled.stdoutBufferedBytes).toBeLessThanOrEqual(MAX_BUFFERED_BYTES);

      // As many again: nothing more is held, every request is still answered.
      await burst(6_000);
      const still = await probe.state();
      expect(still.droppedRecords).toBeGreaterThan(stalled.droppedRecords + 2_900);
      expect(still.bufferedBytes).toBeLessThanOrEqual(stalled.bufferedBytes);
      expect(still.stdoutBufferedBytes).toBeLessThanOrEqual(stalled.stdoutBufferedBytes);
      expect(ids.size).toBe(6_000);

      // The reader resumes: what was held arrives, the writes settle (and the stream drains, if
      // it had pushed back), and records flow again.
      const output = readLines(probe.stdout);
      await until(async () => {
        const { state, bufferedBytes } = await probe.state();
        return state === 'open' && bufferedBytes < MAX_BUFFERED_BYTES / 2;
      }, 'sink writing again');
      const marker = await probe.get('/marker');
      await until(() => output.lines.some((line) => line.includes(marker.requestId)), 'marker');
      const final = await probe.get('/state');
      const { droppedRecords } = JSON.parse(final.body) as SinkProbeState;
      await until(() => output.lines.some((line) => line.includes(final.requestId)), 'final');

      // Whole records only, and exactly one per request that was not dropped.
      expect(output.partial()).toBe('');
      expect(output.lines.length + droppedRecords).toBe(probe.requests());
      for (const line of output.lines) {
        const record = JSON.parse(line) as HttpRequestRecord;
        expect(Object.keys(record).sort()).toEqual(RECORD_FIELDS);
      }
      const recorded = new Set(
        output.lines.map((line) => (JSON.parse(line) as HttpRequestRecord).requestId),
      );
      expect(recorded.size).toBe(output.lines.length);
      expect(recorded.has(marker.requestId)).toBe(true);

      const { code, state } = await probe.shutDown();
      expect(code).toBe(0);
      expect(state.stdoutListeners).toEqual({ error: 0, close: 0, drain: 0 });
    },
    120_000,
  );
});
