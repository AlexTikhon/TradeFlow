import type { VoyageStreamMessage } from '@tradeflow/contracts';

/*
 * A stand-in for the browser's EventSource, which jsdom does not have. It is a simulated
 * transport: no request is made, so it says nothing about cookies, the server or the network.
 * Tests drive it by hand (a message, a dropped connection, the browser giving up) to check what
 * the page does with each. Real streams are tested in the API's integration tests, over HTTP.
 *
 * Install it with `vi.stubGlobal('EventSource', FakeEventSource)`.
 */
export class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  /** Every source created since the last `reset`, oldest first. */
  static instances: FakeEventSource[] = [];

  static reset(): void {
    FakeEventSource.instances = [];
  }

  /** The sources not closed, i.e. connections the page still holds. */
  static open(): FakeEventSource[] {
    return FakeEventSource.instances.filter(
      (source) => source.readyState !== FakeEventSource.CLOSED,
    );
  }

  readonly url: string;
  readonly withCredentials = false;
  readyState = FakeEventSource.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(url: string | URL) {
    this.url = String(url);
    FakeEventSource.instances.push(this);
  }

  /** The path asked for, without the origin. */
  get path(): string {
    return new URL(this.url).pathname;
  }

  close(): void {
    this.readyState = FakeEventSource.CLOSED;
  }

  /**
   * The server sends `message` (any JSON; or a string, sent as is). Dispatched to whatever
   * handler is set, even on a closed source: a late event already on its way when the page
   * closed it, which the page must ignore.
   */
  emit(message: VoyageStreamMessage | Record<string, unknown> | string): void {
    if (this.readyState === FakeEventSource.CONNECTING) this.readyState = FakeEventSource.OPEN;
    const data = typeof message === 'string' ? message : JSON.stringify(message);
    this.onmessage?.(new MessageEvent('message', { data }));
  }

  /** The connection dropped and the browser is reconnecting by itself. */
  drop(): void {
    this.readyState = FakeEventSource.CONNECTING;
    this.onerror?.(new Event('error'));
  }

  /** The browser gave up (the server refused the stream, say): this source is done. */
  fail(): void {
    this.readyState = FakeEventSource.CLOSED;
    this.onerror?.(new Event('error'));
  }
}
