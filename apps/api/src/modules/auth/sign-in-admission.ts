import { performance } from 'node:perf_hooks';
import { Inject, Injectable } from '@nestjs/common';

/*
 * Admission control for `POST /api/auth/sign-in` (ADR 0018): a budget of attempts per client
 * address in fixed windows, and a cap on sign-ins verifying passwords at once. Both are held in
 * this process only: they reset when it restarts and are not shared between API instances.
 */

export interface SignInAdmissionOptions {
  /** Attempts one client address may make per window, whatever their outcome. */
  attemptsPerWindow: number;
  /** Length of a window, which starts at a client's first attempt after the previous one ended. */
  windowMs: number;
  /**
   * Most client addresses tracked at once. Expired windows are reclaimed first; when every
   * tracked window is still running, attempts from new addresses are refused rather than
   * evicting a budget that is being spent.
   */
  maxTrackedClients: number;
  /** Most sign-ins (credential lookup and password verification) running at once. */
  maxConcurrent: number;
  /** Milliseconds from any fixed origin, never going backwards. */
  now: () => number;
}

export const SIGN_IN_ADMISSION_OPTIONS = Symbol('SIGN_IN_ADMISSION_OPTIONS');

export const DEFAULT_SIGN_IN_ADMISSION_OPTIONS: SignInAdmissionOptions = {
  attemptsPerWindow: 20,
  windowMs: 60_000,
  maxTrackedClients: 10_000,
  maxConcurrent: 4,
  // Monotonic, so a wall-clock correction can neither lengthen nor end a window early.
  now: () => performance.now(),
};

/** Whether an attempt may go on; a refusal says how long to wait, in milliseconds. */
export type Admission = { admitted: true } | { admitted: false; retryAfterMs: number };

/** How long a client refused for want of a sign-in slot is told to wait: busy is momentary. */
export const SIGN_IN_BUSY_RETRY_AFTER_MS = 1_000;

interface AttemptWindow {
  startedAt: number;
  attempts: number;
}

@Injectable()
export class SignInAdmission {
  /**
   * Open windows by client address. A window is inserted only when it starts, so iteration
   * order is start order and expired windows are always at the front.
   */
  private readonly windows = new Map<string, AttemptWindow>();
  private running = 0;

  constructor(
    @Inject(SIGN_IN_ADMISSION_OPTIONS) private readonly options: SignInAdmissionOptions,
  ) {}

  /** Counts one sign-in attempt from `client`, or refuses it without counting. */
  admitAttempt(client: string): Admission {
    const { attemptsPerWindow, windowMs, maxTrackedClients } = this.options;
    const now = this.options.now();
    this.reclaimExpired(now);

    let window = this.windows.get(client);
    if (!window) {
      if (this.windows.size >= maxTrackedClients) {
        // Full of running windows: the oldest one is the first to make room.
        const [oldest] = this.windows.values();
        return refused((oldest?.startedAt ?? now) + windowMs - now);
      }
      window = { startedAt: now, attempts: 0 };
      this.windows.set(client, window);
    }
    if (window.attempts >= attemptsPerWindow) {
      return refused(window.startedAt + windowMs - now);
    }
    window.attempts += 1;
    return { admitted: true };
  }

  /**
   * Takes one of the sign-in slots. Returns the function that gives it back (safe to call more
   * than once), or undefined when every slot is taken: the caller is refused, never queued.
   */
  enter(): (() => void) | undefined {
    if (this.running >= this.options.maxConcurrent) {
      return undefined;
    }
    this.running += 1;
    let left = false;
    return () => {
      if (left) return;
      left = true;
      this.running -= 1;
    };
  }

  /** Client addresses tracked now, expired windows included until they are reclaimed. */
  get trackedClients(): number {
    return this.windows.size;
  }

  /** Sign-ins holding a slot now. */
  get runningSignIns(): number {
    return this.running;
  }

  private reclaimExpired(now: number): void {
    for (const [client, { startedAt }] of this.windows) {
      if (now - startedAt < this.options.windowMs) return;
      this.windows.delete(client);
    }
  }
}

const refused = (retryAfterMs: number): Admission => ({
  admitted: false,
  retryAfterMs: Math.max(retryAfterMs, 1),
});
