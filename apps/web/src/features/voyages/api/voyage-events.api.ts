import { type VoyageStreamMessage, VoyageStreamMessageSchema } from '@tradeflow/contracts';

/*
 * The voyage's event stream (`GET /api/voyages/{voyageId}/events`), through the browser's
 * EventSource. Same origin, so the browser attaches the HttpOnly session cookie, as for every
 * other request; no code here sees it. Messages only say that something changed: the data is
 * read again through the REST endpoints.
 */

export interface VoyageEventHandlers {
  /** A message the contract describes. Anything else is ignored. */
  onMessage(message: VoyageStreamMessage): void;
  /**
   * The connection dropped. `retrying`: the browser is reconnecting by itself. Otherwise it gave
   * up (the server refused the stream, for instance after the session ended) and only a new
   * connection can resume.
   */
  onDisconnect(retrying: boolean): void;
}

export interface VoyageEventConnection {
  /** Ends the connection. No handler is called afterwards. */
  close(): void;
}

/** Whether this browser can stream at all; without it, the caller relies on polling. */
export const canStreamVoyageEvents = (): boolean => typeof EventSource !== 'undefined';

export function connectToVoyageEvents(
  voyageId: string,
  handlers: VoyageEventHandlers,
): VoyageEventConnection {
  const url = new URL(
    `/api/voyages/${encodeURIComponent(voyageId)}/events`,
    window.location.origin,
  );
  const source = new EventSource(url);
  source.onmessage = (event: MessageEvent<unknown>) => {
    let data: unknown;
    try {
      data = typeof event.data === 'string' ? JSON.parse(event.data) : undefined;
    } catch {
      return;
    }
    const message = VoyageStreamMessageSchema.safeParse(data);
    if (message.success) handlers.onMessage(message.data);
  };
  source.onerror = () => {
    handlers.onDisconnect(source.readyState !== EventSource.CLOSED);
  };
  return {
    close() {
      source.onmessage = null;
      source.onerror = null;
      source.close();
    },
  };
}
