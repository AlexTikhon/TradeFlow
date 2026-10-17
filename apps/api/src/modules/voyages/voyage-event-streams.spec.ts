import { EventEmitter } from 'node:events';
import type { CounterpartyContract } from '@tradeflow/contracts';
import type { Response } from 'express';
import { afterEach, describe, expect, it } from 'vitest';
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
  held: (() => void)[] = [];
  hold = false;
  checks = 0;
  failNext = false;

  async listForVoyage(): Promise<CounterpartyContract[] | null> {
    this.checks += 1;
    if (this.failNext) {
      this.failNext = false;
      throw new Error('database unavailable');
    }
    if (this.hold) await new Promise<void>((resolve) => this.held.push(resolve));
    return this.visible && this.visible.map((id) => ({ id }) as CounterpartyContract);
  }

  release() {
    this.hold = false;
    for (const resolve of this.held.splice(0)) resolve();
  }
}

class FakeSessions {
  current: Principal | null = principal;
  refresh() {
    return Promise.resolve(this.current);
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('VoyageEventStreams', () => {
  const created: VoyageEventStreams[] = [];
  afterEach(() => {
    for (const streams of created.splice(0)) streams.onModuleDestroy();
  });

  async function aStream({ maxPendingContracts = 32 } = {}) {
    const bus = new VoyageEventBus();
    const contracts = new FakeContracts();
    const sessions = new FakeSessions();
    const streams = new VoyageEventStreams(
      bus,
      contracts as unknown as CounterpartyContracts,
      sessions as unknown as SessionPrincipals,
      { recheckIntervalMs: 60_000, maxPendingContracts },
    );
    created.push(streams);
    const response = new FakeResponse();
    expect(await streams.open(principal, VOYAGE, response as unknown as Response)).toBe(true);
    const publish = (n: number, type: VoyageChange['type'] = 'NOTICE_ISSUED') => {
      bus.publish({ type, voyageId: VOYAGE, contractId: contractId(n) });
    };
    return { bus, contracts, sessions, streams, response, publish };
  }

  it('starts with READY once subscribed', async () => {
    const { bus, response } = await aStream();
    expect(response.messages).toEqual([{ type: 'READY' }]);
    expect(response.chunks[0]).toBe('retry: 5000\n\n');
    expect(bus.listenerCount(VOYAGE)).toBe(1);
  });

  it('opens nothing for a voyage the organization does not participate in', async () => {
    const bus = new VoyageEventBus();
    const contracts = new FakeContracts();
    contracts.visible = null;
    const streams = new VoyageEventStreams(
      bus,
      contracts as unknown as CounterpartyContracts,
      new FakeSessions() as unknown as SessionPrincipals,
      { recheckIntervalMs: 60_000, maxPendingContracts: 32 },
    );
    const response = new FakeResponse();

    expect(await streams.open(principal, VOYAGE, response as unknown as Response)).toBe(false);
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
});
