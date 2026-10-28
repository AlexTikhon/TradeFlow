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
  /** Node options placed before the script, such as `['--import', 'tsx']`. */
  nodeOptions?: string[];
  /** Kills the process when aborted (a run stopped during startup). */
  signal?: AbortSignal;
  /** Kills the process if it is still running after this long. */
  timeoutMs?: number;
  /**
   * In a process group of its own, so a Ctrl+C in the terminal reaches only the parent, which
   * then stops the process itself (the local demo).
   */
  detached?: boolean;
}

function openLog(path: string): WriteStream {
  return createWriteStream(path, { flags: 'w' });
}

function spawnLogged(script: string, args: string[], options: ProcessOptions) {
  const log = openLog(options.logFile);
  const child = spawn(process.execPath, [...(options.nodeOptions ?? []), script, ...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    ...(options.signal !== undefined && { signal: options.signal }),
    ...(options.timeoutMs !== undefined && { timeout: options.timeoutMs }),
    ...(options.detached !== undefined && { detached: options.detached }),
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
  options.signal?.throwIfAborted();
  if (code !== 0) {
    throw new Error(`${name} failed (exit code ${String(code)}); see ${options.logFile}`);
  }
}

/** Resolves true once `exited` settles, or false after `ms`. */
const exitsWithin = (exited: Promise<unknown>, ms: number) => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => {
      resolve(false);
    }, ms);
  });
  return Promise.race([exited.then(() => true), timeout]).finally(() => {
    clearTimeout(timer);
  });
};

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

  /** The operating system's id of the process, for recovery instructions. */
  get pid(): number | undefined {
    return this.child.pid;
  }

  /**
   * Stops the process and waits until it has exited: asked first (SIGTERM; on Windows the
   * process is terminated at once), then forced (SIGKILL). Throws, naming the process id, if it
   * still has not exited after both waits.
   */
  async stop({ graceMs = 10_000, forceMs = 5_000 } = {}): Promise<void> {
    if (this.running) this.child.kill();
    if (await exitsWithin(this.exited, graceMs)) return;
    this.child.kill('SIGKILL');
    if (await exitsWithin(this.exited, forceMs)) return;
    throw new Error(
      `${this.name} (process id ${String(this.pid)}) did not exit after ${graceMs + forceMs} ms`,
    );
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
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    signal?.throwIfAborted();
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
