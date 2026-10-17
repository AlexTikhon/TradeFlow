import { Injectable, Logger } from '@nestjs/common';
import type { VoyageChangeType } from '@tradeflow/contracts';

/**
 * A change that has committed: what happened, on which voyage, under which contract. It stays
 * inside the API. Streams use it to decide who is told, and send on only its type.
 */
export interface VoyageChange {
  type: VoyageChangeType;
  voyageId: string;
  contractId: string;
}

export type VoyageChangeListener = (change: VoyageChange) => void;

/**
 * Publish/subscribe for committed voyage changes, in this process's memory. Commands publish
 * after their transaction has committed; `VoyageEventStreams` subscribes per open stream.
 *
 * Best effort by design: nothing is stored, so a change published while nobody listens, or in
 * another API instance, is never delivered, and nothing is replayed. Clients do not depend on
 * it for correctness: they read through the REST endpoints when a stream (re)connects, and poll
 * while they have none. Durable or multi-instance delivery needs an outbox and a broker.
 */
@Injectable()
export class VoyageEventBus {
  private readonly logger = new Logger(VoyageEventBus.name);
  private readonly listeners = new Map<string, Set<VoyageChangeListener>>();

  /**
   * Hands `change` to every listener of its voyage, synchronously, and returns. A listener that
   * throws is logged and does not stop the others or reach the publisher. Listeners must only
   * schedule their work: the publisher is answering an HTTP request.
   */
  publish(change: VoyageChange): void {
    for (const listener of [...(this.listeners.get(change.voyageId) ?? [])]) {
      try {
        listener(change);
      } catch (error) {
        this.logger.error(
          `A listener failed on ${change.type} for voyage ${change.voyageId}`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }
  }

  /** Listens to one voyage's changes until the returned function is called. */
  subscribe(voyageId: string, listener: VoyageChangeListener): () => void {
    let listeners = this.listeners.get(voyageId);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(voyageId, listeners);
    }
    listeners.add(listener);
    return () => {
      const current = this.listeners.get(voyageId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.listeners.delete(voyageId);
    };
  }

  /** Listeners now: of one voyage, or of all of them. */
  listenerCount(voyageId?: string): number {
    if (voyageId !== undefined) return this.listeners.get(voyageId)?.size ?? 0;
    let count = 0;
    for (const listeners of this.listeners.values()) count += listeners.size;
    return count;
  }
}
