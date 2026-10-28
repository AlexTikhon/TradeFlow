import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { TooManyRequestsException } from '../../common/http/too-many-requests.exception.js';
import type { AppConfig } from '../../config/app-config.js';
import type { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { AuthService } from './auth.service.js';
import { hashPassword, verifyPassword } from './password.js';
import { DEFAULT_SIGN_IN_ADMISSION_OPTIONS, SignInAdmission } from './sign-in-admission.js';

// Hashing is observed, and held, through these: no argon2 work runs in this file.
vi.mock('./password.js', () => ({ hashPassword: vi.fn(), verifyPassword: vi.fn() }));

/** A promise the test settles by hand. */
function aGate<T>() {
  let open: (value: T) => void = () => undefined;
  let fail: (error: unknown) => void = () => undefined;
  const opened = new Promise<T>((resolve, reject) => {
    open = resolve;
    fail = reject;
  });
  return { opened, open, fail };
}

const USER = { id: 'user-1', passwordHash: '$argon2id$stored' };
const PROFILE = {
  id: 'user-1',
  email: 'ana@exporter.example',
  fullName: 'Ana Souza',
  role: 'OPERATOR',
  organization: { id: 'org-1', name: 'Exporter Co', countryCode: 'BR' },
};
const credentials = (n: number) => ({ email: `user${n}@exporter.example`, password: 'secret' });

describe('AuthService.signIn admission', () => {
  let findUnique: Mock<(args: { select: Record<string, unknown> }) => Promise<unknown>>;
  let transaction: Mock<() => Promise<unknown>>;
  let admission: SignInAdmission;
  let service: AuthService;

  beforeEach(() => {
    vi.mocked(hashPassword).mockReset();
    vi.mocked(verifyPassword).mockReset().mockResolvedValue(false);
    findUnique = vi.fn();
    transaction = vi.fn<() => Promise<unknown>>().mockResolvedValue([]);
    const prisma = {
      user: { findUnique },
      session: { updateMany: vi.fn(), deleteMany: vi.fn(), create: vi.fn() },
      $transaction: transaction,
    } as unknown as PrismaService;
    admission = new SignInAdmission(DEFAULT_SIGN_IN_ADMISSION_OPTIONS);
    service = new AuthService(prisma, { session: { ttlMs: 60_000 } } as AppConfig, admission);
  });

  it('refuses a fifth concurrent sign-in at once, before any lookup or hashing', async () => {
    const lookup = aGate<null>();
    findUnique.mockReturnValue(lookup.opened);

    // The lookup is called synchronously on entry, so four calls are four held sign-ins.
    const held = [1, 2, 3, 4].map((n) => service.signIn(credentials(n), undefined));
    expect(findUnique).toHaveBeenCalledTimes(4);

    const refusal = await service.signIn(credentials(5), undefined).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(TooManyRequestsException);
    expect((refusal as TooManyRequestsException).getStatus()).toBe(429);
    expect((refusal as TooManyRequestsException).retryAfterSeconds).toBe(1);
    expect(findUnique).toHaveBeenCalledTimes(4);
    expect(hashPassword).not.toHaveBeenCalled();
    expect(verifyPassword).not.toHaveBeenCalled();

    vi.mocked(hashPassword).mockResolvedValue('$argon2id$dummy');
    lookup.open(null);
    expect(await Promise.all(held)).toEqual([null, null, null, null]);
    expect(admission.runningSignIns).toBe(0);
  });

  it('initialises the dummy hash inside the bound: cold-start hashing holds its slots', async () => {
    findUnique.mockResolvedValue(null); // unknown emails
    const dummy = aGate<string>();
    const hashing = aGate<undefined>();
    vi.mocked(hashPassword).mockImplementation(() => {
      hashing.open(undefined);
      return dummy.opened;
    });

    const held = [1, 2, 3, 4].map((n) => service.signIn(credentials(n), undefined));
    await hashing.opened;

    // While the first dummy hash is computed, its four sign-ins still hold every slot.
    expect(admission.runningSignIns).toBe(4);
    await expect(service.signIn(credentials(5), undefined)).rejects.toBeInstanceOf(
      TooManyRequestsException,
    );
    expect(findUnique).toHaveBeenCalledTimes(4);

    dummy.open('$argon2id$dummy');
    expect(await Promise.all(held)).toEqual([null, null, null, null]);
    // One dummy hash for all of them; every unknown email still verifies against it.
    expect(hashPassword).toHaveBeenCalledTimes(1);
    expect(verifyPassword).toHaveBeenCalledTimes(4);
    expect(vi.mocked(verifyPassword).mock.calls.map(([, hash]) => hash)).toEqual(
      Array(4).fill('$argon2id$dummy'),
    );
    expect(admission.runningSignIns).toBe(0);
  });

  it('gives every slot back after a successful sign-in', async () => {
    findUnique.mockImplementation(({ select }: { select: Record<string, unknown> }) =>
      Promise.resolve('passwordHash' in select ? USER : PROFILE),
    );
    vi.mocked(verifyPassword).mockResolvedValue(true);

    const results = await Promise.all(
      [1, 2, 3, 4].map((n) => service.signIn(credentials(n), undefined)),
    );

    expect(results.every((result) => result?.currentUser.user.id === 'user-1')).toBe(true);
    expect(admission.runningSignIns).toBe(0);
    expect(await service.signIn(credentials(5), undefined)).not.toBeNull();
  });

  it('gives every slot back when the lookup fails', async () => {
    const lookup = aGate<null>();
    findUnique.mockReturnValue(lookup.opened);
    const held = [1, 2, 3, 4].map((n) =>
      service.signIn(credentials(n), undefined).catch((e: unknown) => e),
    );

    lookup.fail(new Error('database unavailable'));
    const errors = await Promise.all(held);

    expect(errors.map((error) => (error as Error).message)).toEqual(
      Array(4).fill('database unavailable'),
    );
    expect(admission.runningSignIns).toBe(0);
    findUnique.mockResolvedValue(null);
    vi.mocked(hashPassword).mockResolvedValue('$argon2id$dummy');
    expect(await service.signIn(credentials(5), undefined)).toBeNull();
  });

  it('gives every slot back when opening the session fails after verification', async () => {
    findUnique.mockResolvedValue(USER);
    vi.mocked(verifyPassword).mockResolvedValue(true);
    transaction.mockRejectedValue(new Error('session write failed'));

    const errors = await Promise.all(
      [1, 2, 3, 4].map((n) => service.signIn(credentials(n), undefined).catch((e: unknown) => e)),
    );

    expect(errors.map((error) => (error as Error).message)).toEqual(
      Array(4).fill('session write failed'),
    );
    expect(admission.runningSignIns).toBe(0);
    expect(admission.enter()).toBeTypeOf('function');
  });
});
