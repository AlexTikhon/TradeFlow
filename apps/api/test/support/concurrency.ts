import type { Prisma } from '../../src/generated/prisma/client.js';
import type { PrismaService } from '../../src/infrastructure/prisma/prisma.service.js';

/*
 * Real races against PostgreSQL. A test holds a row lock in a transaction of its own, starts the
 * competing requests, waits until they are all blocked on that lock (so each has passed every
 * check before it and none can commit yet), then releases them together.
 *
 * The holder can also commit a change of its own as it releases. A read stopped part-way, by a
 * table lock on a table it has not loaded yet, then goes on only after that change committed:
 * between the statements it already ran and the ones still to come.
 */

/** A change made in the holding transaction, so that it commits as the lock is released. */
export type Change = (tx: Prisma.TransactionClient) => Promise<unknown>;

export interface HeldLock {
  /**
   * Ends the holding transaction, letting the blocked statements run. With `change`, first makes
   * it in that transaction, so it has committed before any of them goes on.
   */
  release(change?: Change): Promise<void>;
}

/**
 * Runs `lock` (a `SELECT ... FOR UPDATE`, or a `LOCK TABLE`) in a transaction kept open until
 * `release()`.
 */
export async function holdLock(
  prisma: PrismaService,
  lock: (tx: Prisma.TransactionClient) => Promise<unknown>,
): Promise<HeldLock> {
  let release: (change: Change | undefined) => void = () => undefined;
  const released = new Promise<Change | undefined>((resolve) => {
    release = resolve;
  });
  let locked: () => void = () => undefined;
  const lockTaken = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const holder = prisma.$transaction(
    async (tx) => {
      await lock(tx);
      locked();
      const change = await released;
      await change?.(tx);
    },
    { timeout: 10_000 },
  );
  // If taking the lock fails, fail here instead of waiting forever.
  await Promise.race([lockTaken, holder]);
  return {
    release: async (change) => {
      release(change);
      await holder;
    },
  };
}

/** Waits until `count` sessions of this database are blocked on a lock. */
export async function waitForLockWaiters(prisma: PrismaService, count: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const [row] = await prisma.$queryRaw<{ waiting: number }[]>`
      SELECT count(*)::int AS waiting FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if ((row?.waiting ?? 0) >= count) return;
    if (Date.now() > deadline) {
      throw new Error(`Expected ${count} sessions waiting on a lock, saw ${row?.waiting ?? 0}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Runs `act` while every transaction that inserts into `table` fails at COMMIT: a deferred
 * trigger raises only once COMMIT has been sent, as a connection lost while committing would
 * look to the API, which cannot tell whether the transaction committed. (It did not.)
 */
export async function failCommitsWriting(
  prisma: PrismaService,
  table: string,
  act: () => Promise<void>,
): Promise<void> {
  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION test_commit_unavailable() RETURNS trigger LANGUAGE plpgsql
    AS $$ BEGIN RAISE EXCEPTION 'commit outcome unknown'; END $$`);
  await prisma.$executeRawUnsafe(`
    CREATE CONSTRAINT TRIGGER test_commit_unavailable AFTER INSERT ON ${table}
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION test_commit_unavailable()`);
  try {
    await act();
  } finally {
    await prisma.$executeRawUnsafe(`DROP TRIGGER test_commit_unavailable ON ${table}`);
    await prisma.$executeRawUnsafe('DROP FUNCTION test_commit_unavailable()');
  }
}

/** Runs `act` while every insert into `audit_events` fails, like an unavailable audit store. */
export async function failAuditWrites(
  prisma: PrismaService,
  act: () => Promise<void>,
): Promise<void> {
  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION test_audit_unavailable() RETURNS trigger LANGUAGE plpgsql
    AS $$ BEGIN RAISE EXCEPTION 'audit store unavailable'; END $$`);
  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER test_audit_unavailable BEFORE INSERT ON audit_events
    FOR EACH ROW EXECUTE FUNCTION test_audit_unavailable()`);
  try {
    await act();
  } finally {
    await prisma.$executeRawUnsafe('DROP TRIGGER test_audit_unavailable ON audit_events');
    await prisma.$executeRawUnsafe('DROP FUNCTION test_audit_unavailable()');
  }
}
