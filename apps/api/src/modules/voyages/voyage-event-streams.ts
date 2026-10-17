import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import type { VoyageChangeType, VoyageStreamMessage } from '@tradeflow/contracts';
import type { Response } from 'express';
import type { Principal } from '../auth/principal.js';
import { SessionPrincipals } from '../auth/session-principals.js';
import { CounterpartyContracts } from './counterparty-contracts.js';
import { type VoyageChange, VoyageEventBus } from './voyage-event-bus.js';

export interface VoyageEventStreamOptions {
  /**
   * How often every open stream re-reads its session and participation, and sends a heartbeat.
   * A stream whose session ends while nothing is sent on it is closed within this interval: the
   * revocation window of an idle stream.
   */
  recheckIntervalMs: number;
  /**
   * Most contracts a stream may hold undelivered signals for. Signals for one contract are
   * coalesced by type, so this bounds the queue; a stream that would exceed it is closed, and its
   * client catches up by reading again when it reconnects.
   */
  maxPendingContracts: number;
}

export const VOYAGE_EVENT_STREAM_OPTIONS = Symbol('VOYAGE_EVENT_STREAM_OPTIONS');

export const DEFAULT_VOYAGE_EVENT_STREAM_OPTIONS: VoyageEventStreamOptions = {
  recheckIntervalMs: 30_000,
  maxPendingContracts: 32,
};

/** How long a browser waits before reconnecting a stream that ended (the SSE `retry` field). */
const RECONNECT_DELAY_MS = 5_000;

interface Stream {
  /** The principal the stream was opened for. Its session and organization must stay the same. */
  readonly principal: Principal;
  readonly voyageId: string;
  readonly response: Response;
  /** Undelivered signals: contract id → the types of change under it, coalesced. */
  readonly pending: Map<string, Set<VoyageChangeType>>;
  unsubscribe: () => void;
  /** A check against the database is running for this stream (a delivery or a recheck). */
  busy: boolean;
  closed: boolean;
}

/**
 * Open event streams of voyages (`GET /voyages/:voyageId/events`) and what is sent on them.
 *
 * Signals about a contract reveal activity under it even without data, so they follow the same
 * rule as the contract's notices and timeline events (ADR 0011): only its current two
 * counterparties are told. Nothing is decided when the stream opens beyond participation; every
 * delivery first reads the session again (it may have expired or been revoked, or the user may
 * have moved organization) and the organization's contracts on the voyage now. A stream whose
 * session or participation is gone is closed instead. Idle streams are re-checked every
 * `recheckIntervalMs`.
 *
 * Only the change's type is written: no ids and no audit payload. Memory per stream is bounded:
 * signals are coalesced per contract and type, a stream with too many is closed, and so is one
 * whose client stops reading (the socket buffer is full). Closing loses nothing a client needs:
 * it reconnects and reads again.
 */
@Injectable()
export class VoyageEventStreams implements OnModuleDestroy {
  private readonly logger = new Logger(VoyageEventStreams.name);
  private readonly streams = new Set<Stream>();
  private recheckTimer: NodeJS.Timeout | undefined;
  private rechecking = false;

  constructor(
    private readonly bus: VoyageEventBus,
    private readonly contracts: CounterpartyContracts,
    private readonly sessions: SessionPrincipals,
    @Inject(VOYAGE_EVENT_STREAM_OPTIONS) private readonly options: VoyageEventStreamOptions,
  ) {}

  /**
   * Starts streaming the voyage's changes on `response`, for as long as the client stays and its
   * session and participation last. False, with nothing written, when the voyage does not exist
   * or the principal's organization does not participate in it (the caller answers 404).
   */
  async open(principal: Principal, voyageId: string, response: Response): Promise<boolean> {
    const client = { gone: false };
    const onGone = () => {
      client.gone = true;
    };
    response.once('close', onGone);
    let contracts: Awaited<ReturnType<CounterpartyContracts['listForVoyage']>>;
    try {
      contracts = await this.contracts.listForVoyage(principal, voyageId);
    } finally {
      response.off('close', onGone);
    }
    if (!contracts) return false;
    if (client.gone) return true; // The client left while access was being checked.

    const stream: Stream = {
      principal,
      voyageId,
      response,
      pending: new Map(),
      unsubscribe: () => undefined,
      busy: false,
      closed: false,
    };
    // Subscribe before READY: whatever commits after the client hears READY is signalled.
    stream.unsubscribe = this.bus.subscribe(voyageId, (change) => {
      this.enqueue(stream, change);
    });
    this.streams.add(stream);
    response.on('close', () => {
      this.close(stream);
    });

    response.status(200);
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    // Reverse proxies such as nginx would otherwise buffer the stream.
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders();
    response.socket?.setNoDelay(true);
    response.write(`retry: ${RECONNECT_DELAY_MS}\n\n`);
    this.send(stream, { type: 'READY' });
    this.startRechecks();
    return true;
  }

  /** Streams open now. */
  get size(): number {
    return this.streams.size;
  }

  onModuleDestroy(): void {
    this.stopRechecks();
    for (const stream of [...this.streams]) this.close(stream);
  }

  private enqueue(stream: Stream, change: VoyageChange): void {
    if (stream.closed) return;
    let types = stream.pending.get(change.contractId);
    if (!types) {
      if (stream.pending.size >= this.options.maxPendingContracts) {
        this.logger.warn(`Closing a stream of voyage ${stream.voyageId}: too many pending signals`);
        this.close(stream);
        return;
      }
      types = new Set();
      stream.pending.set(change.contractId, types);
    }
    types.add(change.type);
    void this.deliver(stream);
  }

  /** Sends the pending signals the stream's organization may receive now, checking it first. */
  private async deliver(stream: Stream): Promise<void> {
    if (stream.busy || stream.closed) return;
    stream.busy = true;
    try {
      while (hasPending(stream)) {
        const batch = [...stream.pending];
        stream.pending.clear();
        const visible = await this.visibleContracts(stream);
        if (!visible) {
          this.close(stream);
          return;
        }
        for (const [contractId, types] of batch) {
          if (!visible.has(contractId)) continue;
          for (const type of types) this.send(stream, { type });
        }
      }
    } catch (error) {
      this.fail(stream, error);
    } finally {
      stream.busy = false;
    }
    // Signals that arrived while a recheck held the stream.
    if (hasPending(stream)) void this.deliver(stream);
  }

  /**
   * The ids of the voyage's contracts the stream's organization is a counterparty to now. Null
   * when the stream must end: its session expired or was revoked, its user moved to another
   * organization, or that organization no longer participates in the voyage.
   */
  private async visibleContracts(stream: Stream): Promise<Set<string> | null> {
    const principal = await this.sessions.refresh(stream.principal);
    if (!principal || principal.organizationId !== stream.principal.organizationId) {
      return null;
    }
    const contracts = await this.contracts.listForVoyage(principal, stream.voyageId);
    return contracts && new Set(contracts.map(({ id }) => id));
  }

  private send(stream: Stream, message: VoyageStreamMessage): void {
    this.write(stream, `data: ${JSON.stringify(message)}\n\n`);
  }

  private write(stream: Stream, chunk: string): void {
    if (stream.closed) return;
    if (stream.response.writableNeedDrain) {
      // The client is not reading; buffering for it would grow without bound.
      this.close(stream);
      return;
    }
    stream.response.write(chunk);
  }

  private close(stream: Stream): void {
    if (stream.closed) return;
    stream.closed = true;
    stream.pending.clear();
    stream.unsubscribe();
    this.streams.delete(stream);
    if (!stream.response.writableEnded) stream.response.end();
    if (this.streams.size === 0) this.stopRechecks();
  }

  /** A check could not be made: the stream cannot be kept authorized, so it ends. */
  private fail(stream: Stream, error: unknown): void {
    this.logger.error(
      `Closing a stream of voyage ${stream.voyageId}: its access could not be checked`,
      error instanceof Error ? error.stack : String(error),
    );
    this.close(stream);
  }

  private startRechecks(): void {
    if (this.recheckTimer) return;
    this.recheckTimer = setInterval(() => {
      void this.recheckAll();
    }, this.options.recheckIntervalMs);
    this.recheckTimer.unref();
  }

  private stopRechecks(): void {
    clearInterval(this.recheckTimer);
    this.recheckTimer = undefined;
  }

  /**
   * One round over every stream, one at a time: ends those whose session or participation is
   * gone, and sends the others a comment, which keeps proxies from closing a quiet connection.
   * A stream busy delivering is skipped: the delivery checks it anyway. Rounds never overlap.
   */
  private async recheckAll(): Promise<void> {
    if (this.rechecking) return;
    this.rechecking = true;
    try {
      for (const stream of [...this.streams]) {
        if (stream.closed || stream.busy) continue;
        stream.busy = true;
        try {
          if (await this.visibleContracts(stream)) {
            this.write(stream, ': keep-alive\n\n');
          } else {
            this.close(stream);
          }
        } catch (error) {
          this.fail(stream, error);
        } finally {
          stream.busy = false;
        }
        if (hasPending(stream)) void this.deliver(stream);
      }
    } finally {
      this.rechecking = false;
    }
  }
}

/**
 * Whether signals wait to be delivered on a stream still open. A function, not an inline test:
 * `closed` and `pending` change while a check is awaited.
 */
function hasPending(stream: Stream): boolean {
  return !stream.closed && stream.pending.size > 0;
}
