import { type ChildProcess, spawn } from 'node:child_process';
import { createWriteStream, type WriteStream } from 'node:fs';
import { createServer } from 'node:net';

/*
 * Child processes the run owns. Each is the Node binary running a script directly (no shell), so
 * stopping it stops exactly that process, on Windows as on Linux, and nothing else: servers
 * this run did not start, such as `pnpm dev`, are never looked up or touched.
 */

interface ProcessOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Receives the process's stdout and stderr. */
  logFile: string;
}

function openLog(path: string): WriteStream {
  return createWriteStream(path, { flags: 'w' });
}

function spawnLogged(script: string, args: string[], options: ProcessOptions) {
  const log = openLog(options.logFile);
  const child = spawn(process.execPath, [script, ...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => {
      resolve(code);
    });
    child.once('error', () => {
      resolve(null);
    });
  }).finally(() => {
    log.end();
  });
  return { child, exited };
}

/** Runs a script to completion; rejects, naming its log, unless it exits with 0. */
export async function runScript(
  name: string,
  script: string,
  args: string[],
  options: ProcessOptions,
): Promise<void> {
  const code = await spawnLogged(script, args, options).exited;
  if (code !== 0) {
    throw new Error(`${name} failed (exit code ${String(code)}); see ${options.logFile}`);
  }
}

/** A long-running server process started by this run. */
export class OwnedProcess {
  private constructor(
    readonly name: string,
    private readonly child: ChildProcess,
    readonly exited: Promise<number | null>,
    readonly logFile: string,
  ) {}

  static start(name: string, script: string, args: string[], options: ProcessOptions) {
    const { child, exited } = spawnLogged(script, args, options);
    return new OwnedProcess(name, child, exited, options.logFile);
  }

  get running(): boolean {
    return this.child.exitCode === null && this.child.signalCode === null;
  }

  /** Stops the process and waits until it has exited. */
  async stop(): Promise<void> {
    if (this.running) this.child.kill();
    await this.exited;
  }

  /** Last resort when the runner itself is exiting: synchronous, no waiting. */
  killNow(): void {
    if (this.running) this.child.kill();
  }
}

/** A TCP port free on the loopback interface right now, chosen by the operating system. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === 'object') resolve(address.port);
        else reject(new Error('No port was assigned'));
      });
    });
  });
}

/**
 * Waits until `url` answers 200, or fails as soon as `owner` exits or `timeoutMs` passes. This
 * waits for a condition (the server is up), checking it every 250 ms; it never sleeps a fixed
 * time to hope the server is ready.
 */
export async function waitUntilServing(
  url: string,
  owner: OwnedProcess,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!owner.running) {
      throw new Error(`${owner.name} exited before serving ${url}; see ${owner.logFile}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      await response.body?.cancel();
      if (response.status === 200) return;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) {
      throw new Error(`${owner.name} did not serve ${url} within ${timeoutMs} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
