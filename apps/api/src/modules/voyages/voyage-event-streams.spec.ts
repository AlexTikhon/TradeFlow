import { EventEmitter } from 'node:events';
import type { CounterpartyContract } from '@tradeflow/contracts';
import type { Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Principal } from '../auth/principal.js';
import type { SessionPrincipals } from '../auth/session-principals.js';
import type { CounterpartyContracts } from './counterparty-contracts.js';
import { type VoyageChange, VoyageEventBus } from './voyage-event-bus.js';
import { VoyageEventStreams } from './voyage-event-streams.js';

/*
 * The bounds of a stream: what is kept for a stream while its access is being checked, and when
 * it is closed instead. The database is replaced by fakes whose answers a test can hold back;
 * everything that reads it for real is covered by test/voyage-events.int-spec.ts.
 */

const VOYAGE = '01990000-0000-7000-8003-000000000001';
const contractId = (n: number) => `01990000-0000-7000-8008-${String(n).padStart(12, '0')}`;
const principal: Principal = {
  sessionId: '01990000-0000-7000-8004-000000000001',
  userId: '01990000-0000-7000-8002-000000000001',
  organizationId: '01990000-0000-7000-8001-000000000001',
  role: 'VIEWER',
};

/** Enough of an Express response for a stream, recording what was written. */
class FakeResponse extends EventEmitter {
  readonly chunks: string[] = [];
  ends = 0;
  writableEnded = false;
  writableNeedDrain = false;
  socket = { setNoDelay: () => undefined };
  status() {
    return this;
  }
  setHeader() {
    return this;
  }
  flushHeaders() {}
  write(chunk: string) {
    this.chunks.push(chunk);
    return true;
  }
  end() {
    this.ends += 1;
    this.writableEnded = true;
    this.emit('close');
  }
  /** The `data` of every event written, parsed. */
  get messages() {
    return this.chunks
      .filter((chunk) => chunk.startsWith('data: '))
      .map((chunk) => JSON.parse(chunk.slice('data: '.length)) as unknown);
  }
}

/** The organization's contracts on the voyage, answered when the test says so. */
class FakeContracts {
  visible: string[] | null = [contractId(1)];
  held: { resolve: () => void; reject: (error: Error) => void }[] = [];
  hold = false;
  checks = 0;
  failNext = false;

  async listForVoyage(): Promise<CounterpartyContract[] | null> {
    this.checks += 1;
    if (this.failNext) {
      this.failNext = false;
      throw new Error('database unavailable');
    }
    if (this.hold) {
      await new Promise<void>((resolve, reject) => this.held.push({ resolve, reject }));
    }
    return this.visible && this.visible.map((id) => ({ id }) as CounterpartyContract);
  }

  /** Answers the held checks. */
  release() {
    this.hold = false;
    for (const { resolve } of this.held.splice(0)) resolve();
  }

  /** Fails the held checks. */
  fail() {
    this.hold = false;
    for (const { reject } of this.held.splice(0)) reject(new Error('database unavailable'));
  }
}

class FakeSessions {
  current: Principal | null = principal;
  refresh() {
    return Promise.resolve(this.current);
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const RECHECK_MS = 60_000;

/** Counts the recheck timers started from now on. */
const recheckTimers = () => {
  const setInterval = vi.spyOn(globalThis, 'setInterval');
  return () => setInterval.mock.calls.filter(([, ms]) => ms === RECHECK_MS).length;
};

describe('VoyageEventStreams', () => {
  const created: VoyageEventStreams[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const streams of created.splice(0)) streams.onModuleDestroy();
  });

  /** The service and its fakes, with no stream open yet. */
  function aService({ maxPendingContracts = 32 } = {}) {
    const bus = new VoyageEventBus();
    const contracts = new FakeContracts();
    const sessions = new FakeSessions();
    const streams = new VoyageEventStreams(
      bus,
      contracts as unknown as CounterpartyContracts,
      sessions as unknown as SessionPrincipals,
      { recheckIntervalMs: RECHECK_MS, maxPendingContracts },
    );
    created.push(streams);
    const open = (response: FakeResponse) =>
      streams.open(principal, VOYAGE, response as unknown as Response);
    return { bus, contracts, sessions, streams, open };
  }

  async function aStream({ maxPendingContracts = 32 } = {}) {
    const { bus, contracts, sessions, streams, open } = aService({ maxPendingContracts });
    const response = new FakeResponse();
    expect(await open(response)).toBe('streaming');
    const publish = (n: number, type: VoyageChange['type'] = 'NOTICE_ISSUED') => {
      bus.publish({ type, voyageId: VOYAGE, contractId: contractId(n) });
    };
    return { bus, contracts, sessions, streams, open, response, publish };
  }

  it('starts with READY once subscribed', async () => {
    const { bus, response } = await aStream();
    expect(response.messages).toEqual([{ type: 'READY' }]);
    expect(response.chunks[0]).toBe('retry: 5000\n\n');
    expect(bus.listenerCount(VOYAGE)).toBe(1);
  });

  it('opens nothing for a voyage the organization does not participate in', async () => {
    const { bus, contracts, streams, open } = aService();
    contracts.visible = null;
    const response = new FakeResponse();

    expect(await open(response)).toBe('not-found');
    expect(response.chunks).toEqual([]);
    expect(streams.size).toBe(0);
    expect(bus.listenerCount()).toBe(0);
  });

  it('checks access before every delivery, and sends only what is visible now', async () => {
    const { contracts, response, publish } = await aStream();
    contracts.visible = [contractId(1)];

    publish(1);
    publish(2);
    await settle();

    expect(response.messages).toEqual([{ type: 'READY' }, { type: 'NOTICE_ISSUED' }]);
    // The open, then one check per batch: the first signal was taken at once, the second while
    // the first was being checked.
    expect(contracts.checks).toBe(3);
  });

  it('keeps one signal per contract and type while a check is running', async () => {
    const { contracts, response, publish } = await aStream();
    contracts.hold = true;

    publish(1); // Taken at once; its check is held.
    await settle();
    for (let i = 0; i < 100; i += 1) {
      publish(1);
      publish(1, 'NOTICE_ACKNOWLEDGED');
    }
    contracts.release();
    await settle();
    await settle();

    expect(response.messages).toEqual([
      { type: 'READY' },
      { type: 'NOTICE_ISSUED' },
      { type: 'NOTICE_ISSUED' },
      { type: 'NOTICE_ACKNOWLEDGED' },
    ]);
  });

  it('closes a stream that would hold signals for too many contracts', async () => {
    const { bus, contracts, streams, response, publish } = await aStream({
      maxPendingContracts: 2,
    });
    contracts.visible = [contractId(1), contractId(2), contractId(3), contractId(4)];
    contracts.hold = true;

    publish(1); // Taken; its check is held.
    await settle();
    publish(2);
    publish(3);
    expect(response.writableEnded).toBe(false);
    publish(4);

    expect(response.writableEnded).toBe(true);
    expect(streams.size).toBe(0);
    expect(bus.listenerCount()).toBe(0);
    contracts.release();
    await settle();
    // Nothing is written after the end.
    expect(response.messages).toEqual([{ type: 'READY' }]);
  });

  it('closes a stream whose client stops reading', async () => {
    const { streams, response, publish } = await aStream();
    response.writableNeedDrain = true;

    publish(1);
    await settle();

    expect(response.writableEnded).toBe(true);
    expect(response.messages).toEqual([{ type: 'READY' }]);
    expect(streams.size).toBe(0);
  });

  it('closes the stream instead of delivering once the session has ended', async () => {
    const { sessions, response, publish } = await aStream();
    sessions.current = null;

    publish(1);
    await settle();

    expect(response.writableEnded).toBe(true);
    expect(response.messages).toEqual([{ type: 'READY' }]);
  });

  it('closes the stream when the user now acts for another organization', async () => {
    const { sessions, response, publish } = await aStream();
    sessions.current = { ...principal, organizationId: '01990000-0000-7000-8001-000000000009' };

    publish(1);
    await settle();

    expect(response.writableEnded).toBe(true);
    expect(response.messages).toEqual([{ type: 'READY' }]);
  });

  it('closes the stream when access cannot be checked', async () => {
    const { contracts, response, publish } = await aStream();
    contracts.failNext = true;

    publish(1);
    await settle();

    expect(response.writableEnded).toBe(true);
    expect(response.messages).toEqual([{ type: 'READY' }]);
  });

  it('lets go of a stream whose client disconnected', async () => {
    const { bus, streams, response, publish } = await aStream();

    response.emit('close');
    publish(1);
    await settle();

    expect(streams.size).toBe(0);
    expect(bus.listenerCount()).toBe(0);
    expect(response.messages).toEqual([{ type: 'READY' }]);
  });

  it('ends every stream once, however often shutdown and disconnects follow', async () => {
    const { bus, streams, open, response, publish } = await aStream();
    const other = new FakeResponse();
    expect(await open(other)).toBe('streaming');

    streams.onModuleDestroy();
    streams.onModuleDestroy();
    other.emit('close'); // The client's own disconnect, after the server ended its stream.
    publish(1);
    await settle();

    expect(response.ends).toBe(1);
    expect(other.ends).toBe(1);
    expect(streams.size).toBe(0);
    expect(bus.listenerCount()).toBe(0);
    expect(response.messages).toEqual([{ type: 'READY' }]);
    expect(other.messages).toEqual([{ type: 'READY' }]);
  });

  describe('while a stream is being opened', () => {
    /** Starts opening a stream whose access check is held, and waits until it is. */
    async function anOpening() {
      const service = aService();
      service.contracts.hold = true;
      const response = new FakeResponse();
      const opening = service.open(response);
      await settle();
      expect(service.contracts.held).toHaveLength(1);
      return { ...service, response, opening };
    }

    /** Nothing at all was kept for the opening, or written to it. */
    function expectNothingOpened({
      bus,
      streams,
      response,
    }: Awaited<ReturnType<typeof anOpening>>) {
      expect(response.chunks).toEqual([]);
      expect(response.ends).toBe(0);
      expect(response.listenerCount('close')).toBe(0);
      expect(streams.size).toBe(0);
      expect(bus.listenerCount()).toBe(0);
    }

    it('answers shutdown at once, and opens nothing when the check completes later', async () => {
      const timers = recheckTimers();
      const opening = await anOpening();

      opening.streams.onModuleDestroy();

      // Before the check is answered.
      expect(await opening.opening).toBe('shutting-down');
      expect(opening.contracts.held).toHaveLength(1);
      opening.contracts.release();
      await settle();
      expectNothingOpened(opening);
      expect(timers()).toBe(0);
    });

    it('opens nothing when the check fails after shutdown', async () => {
      const timers = recheckTimers();
      const opening = await anOpening();

      opening.streams.onModuleDestroy();
      expect(await opening.opening).toBe('shutting-down');
      opening.contracts.fail();
      await settle();

      expectNothingOpened(opening);
      expect(timers()).toBe(0);
    });

    it('answers a client that left at once, and opens nothing when the check completes', async () => {
      const timers = recheckTimers();
      const opening = await anOpening();

      opening.response.emit('close');

      expect(await opening.opening).toBe('client-gone');
      expect(opening.contracts.held).toHaveLength(1);
      opening.contracts.release();
      await settle();
      expectNothingOpened(opening);
      expect(timers()).toBe(0);
      // A shutdown afterwards finds nothing left to end.
      opening.streams.onModuleDestroy();
      expectNothingOpened(opening);
    });

    it('creates nothing once shut down', async () => {
      const timers = recheckTimers();
      const { bus, contracts, streams, open } = aService();
      streams.onModuleDestroy();
      const response = new FakeResponse();

      expect(await open(response)).toBe('shutting-down');

      expect(contracts.checks).toBe(0);
      expect(response.chunks).toEqual([]);
      expect(response.listenerCount('close')).toBe(0);
      expect(streams.size).toBe(0);
      expect(bus.listenerCount()).toBe(0);
      expect(timers()).toBe(0);
    });
  });
});
