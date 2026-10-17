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

/**
 * What `open` did. Only `streaming` wrote anything: otherwise the caller answers.
 * - `streaming`: the stream is open.
 * - `not-found`: the voyage does not exist, or the organization does not participate in it.
 * - `shutting-down`: the application is shutting down; no stream opens any more.
 * - `client-gone`: the client left before access was decided; there is no one to answer.
 */
export type StreamOpening = 'streaming' | 'not-found' | 'shutting-down' | 'client-gone';

/** Why an opening stopped waiting for its access check. */
type Interruption = Extract<StreamOpening, 'shutting-down' | 'client-gone'>;

type VoyageContracts = Awaited<ReturnType<CounterpartyContracts['listForVoyage']>>;

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
 * rule as the contract's notices, documentary instructions and timeline events (ADR 0011, ADR
 * 0012): only its current two counterparties are told. Nothing is decided when the stream opens
 * beyond participation; every delivery first reads the session again (it may have expired or
 * been revoked, or the user may have moved organization) and the organization's contracts on the
 * voyage now. A stream whose
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
  /** Streams being opened (their access is being checked), each by how to interrupt it. */
  private readonly openings = new Set<(reason: Interruption) => void>();
  /** Set once by shutdown, never cleared: nothing opens afterwards. */
  private shutDown = false;
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
   * session and participation last. Unless it answers `streaming`, nothing is kept and nothing
   * was written: the caller answers.
   *
   * Access is checked first. Neither a shutdown nor the client leaving waits for that check:
   * either answers at once, and the check's late result, or failure, is ignored.
   */
  async open(principal: Principal, voyageId: string, response: Response): Promise<StreamOpening> {
    if (this.shutDown) return 'shutting-down';
    let interruption: Interruption | undefined;
    let interrupt: (reason: Interruption) => void = () => undefined;
    const interrupted = new Promise<undefined>((resolve) => {
      interrupt = (reason) => {
        interruption ??= reason;
        resolve(undefined);
      };
    });
    const onGone = () => {
      interrupt('client-gone');
    };
    // Tracked before the first await: a shutdown from now on reaches this opening.
    this.openings.add(interrupt);
    response.once('close', onGone);
    let checked: { contracts: VoyageContracts } | undefined;
    try {
      checked = await Promise.race([
        this.contracts.listForVoyage(principal, voyageId).then((contracts) => ({ contracts })),
        interrupted,
      ]);
    } catch (error) {
      // A check that fails once the opening was interrupted has no one left to answer.
      if (!interruption) throw error;
    } finally {
      this.openings.delete(interrupt);
      response.off('close', onGone);
    }
    // Also set when the interruption came after the check, before this resumed.
    if (interruption) return interruption;
    if (!checked?.contracts) return 'not-found';

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
    return 'streaming';
  }

  /** Streams open now. */
  get size(): number {
    return this.streams.size;
  }

  /**
   * Shuts down for good: ends every open stream, answers every opening with `shutting-down`, and
   * opens nothing more. Calling it again changes nothing.
   */
  onModuleDestroy(): void {
    this.shutDown = true;
    this.stopRechecks();
    for (const interrupt of [...this.openings]) interrupt('shutting-down');
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
    if (this.recheckTimer || this.shutDown) return;
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
