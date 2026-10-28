import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SIGN_IN_ADMISSION_OPTIONS,
  SignInAdmission,
  type SignInAdmissionOptions,
} from './sign-in-admission.js';

/** A clock the test moves by hand, so windows end exactly when a test says. */
function aClock(start = 1_000_000) {
  const clock = { now: start, advance: (ms: number) => (clock.now += ms) };
  return clock;
}

function anAdmission(options: Partial<SignInAdmissionOptions> = {}) {
  const clock = aClock();
  const admission = new SignInAdmission({
    ...DEFAULT_SIGN_IN_ADMISSION_OPTIONS,
    now: () => clock.now,
    ...options,
  });
  return { admission, clock };
}

/** Makes `count` attempts from `client` and returns how many were admitted. */
function attempt(admission: SignInAdmission, client: string, count: number) {
  let admitted = 0;
  for (let i = 0; i < count; i += 1) {
    if (admission.admitAttempt(client).admitted) admitted += 1;
  }
  return admitted;
}

describe('SignInAdmission defaults', () => {
  it('are 20 attempts per address per minute, 10,000 addresses and 4 sign-ins at once', () => {
    expect(DEFAULT_SIGN_IN_ADMISSION_OPTIONS).toMatchObject({
      attemptsPerWindow: 20,
      windowMs: 60_000,
      maxTrackedClients: 10_000,
      maxConcurrent: 4,
    });
  });
});

describe('SignInAdmission attempt budget', () => {
  it('admits exactly the budget in a window and refuses the next attempt', () => {
    const { admission } = anAdmission();

    expect(attempt(admission, '203.0.113.7', 20)).toBe(20);
    expect(admission.admitAttempt('203.0.113.7')).toEqual({
      admitted: false,
      retryAfterMs: 60_000,
    });
  });

  it('keeps refusing until the window ends, then opens a full new window', () => {
    const { admission, clock } = anAdmission();
    attempt(admission, '203.0.113.7', 20);

    clock.advance(59_999);
    expect(admission.admitAttempt('203.0.113.7')).toEqual({ admitted: false, retryAfterMs: 1 });

    clock.advance(1);
    expect(attempt(admission, '203.0.113.7', 21)).toBe(20);
    expect(admission.admitAttempt('203.0.113.7')).toEqual({
      admitted: false,
      retryAfterMs: 60_000,
    });
  });

  it('starts a window at the first attempt, not on a shared boundary', () => {
    const { admission, clock } = anAdmission();
    attempt(admission, '203.0.113.7', 1);
    clock.advance(30_000);
    expect(attempt(admission, '203.0.113.7', 19)).toBe(19);

    // The window began 30 s ago, so it has 30 s left, however recent the last attempt was.
    expect(admission.admitAttempt('203.0.113.7')).toEqual({
      admitted: false,
      retryAfterMs: 30_000,
    });
  });

  it('does not count refused attempts against the next window', () => {
    const { admission, clock } = anAdmission({ attemptsPerWindow: 2 });
    attempt(admission, '203.0.113.7', 50);

    clock.advance(60_000);
    expect(attempt(admission, '203.0.113.7', 3)).toBe(2);
  });

  it('gives each address a budget of its own', () => {
    const { admission } = anAdmission();
    attempt(admission, '203.0.113.7', 20);

    expect(attempt(admission, '203.0.113.8', 20)).toBe(20);
    expect(attempt(admission, '2001:db8::1', 20)).toBe(20);
    expect(admission.admitAttempt('203.0.113.7').admitted).toBe(false);
  });
});

describe('SignInAdmission storage bound', () => {
  it('refuses new addresses when full of running windows, without evicting any', () => {
    const { admission, clock } = anAdmission({ maxTrackedClients: 3, attemptsPerWindow: 5 });
    attempt(admission, 'a', 5); // spent
    clock.advance(10_000);
    attempt(admission, 'b', 1);
    attempt(admission, 'c', 1);

    // Room is made only when the oldest window ends, 50 s from now.
    expect(admission.admitAttempt('d')).toEqual({ admitted: false, retryAfterMs: 50_000 });
    expect(admission.trackedClients).toBe(3);
    // The spent budget is still enforced, and the tracked addresses keep theirs.
    expect(admission.admitAttempt('a').admitted).toBe(false);
    expect(attempt(admission, 'b', 4)).toBe(4);
  });

  it('reclaims expired windows to make room for new addresses', () => {
    const { admission, clock } = anAdmission({ maxTrackedClients: 3 });
    attempt(admission, 'a', 1);
    clock.advance(10_000);
    attempt(admission, 'b', 1);
    attempt(admission, 'c', 1);

    clock.advance(50_000); // a's window has ended; b's and c's have not
    expect(admission.admitAttempt('d').admitted).toBe(true);
    expect(admission.trackedClients).toBe(3);
    expect(admission.admitAttempt('e').admitted).toBe(false);

    clock.advance(10_000); // b and c end too
    expect(admission.admitAttempt('e').admitted).toBe(true);
    expect(admission.trackedClients).toBe(2); // d and e
  });

  it('drops expired windows on any later attempt, so memory follows recent traffic', () => {
    const { admission, clock } = anAdmission();
    for (let i = 0; i < 1_000; i += 1) admission.admitAttempt(`198.51.100.${i}`);
    expect(admission.trackedClients).toBe(1_000);

    clock.advance(60_000);
    admission.admitAttempt('203.0.113.7');
    expect(admission.trackedClients).toBe(1);
  });

  it('never tracks more addresses than its bound', () => {
    const { admission, clock } = anAdmission({ maxTrackedClients: 100 });
    for (let i = 0; i < 1_000; i += 1) {
      admission.admitAttempt(`client-${i}`);
      clock.advance(100);
      expect(admission.trackedClients).toBeLessThanOrEqual(100);
    }
  });
});

describe('SignInAdmission concurrency', () => {
  it('lets at most the configured number of sign-ins in, and refuses rather than queues', () => {
    const { admission } = anAdmission();
    const slots = [1, 2, 3, 4].map(() => admission.enter());

    expect(slots.every((leave) => typeof leave === 'function')).toBe(true);
    expect(admission.enter()).toBeUndefined();
    expect(admission.runningSignIns).toBe(4);

    slots[0]?.();
    expect(admission.runningSignIns).toBe(3);
    expect(admission.enter()).toBeTypeOf('function');
    expect(admission.enter()).toBeUndefined();
  });

  it('gives a slot back only once, however often it is released', () => {
    const { admission } = anAdmission({ maxConcurrent: 2 });
    const first = admission.enter();
    admission.enter();

    first?.();
    first?.();
    expect(admission.runningSignIns).toBe(1);
    expect(admission.enter()).toBeTypeOf('function');
    expect(admission.enter()).toBeUndefined();
  });

  it('is independent of the attempt budget', () => {
    const { admission } = anAdmission({ attemptsPerWindow: 1 });
    attempt(admission, '203.0.113.7', 5);

    expect(admission.enter()).toBeTypeOf('function');
  });
});
