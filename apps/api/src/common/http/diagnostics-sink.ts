import type { Writable } from 'node:stream';
import type { HttpDiagnosticsSink } from './http-diagnostics.js';

/*
 * The production diagnostics writer (see docs/architecture.md, "HTTP diagnostics"): best effort,
 * bounded, never awaited. It hands whole records to a stream while the stream keeps up and drops
 * whole records when it does not. It never queues, retries, truncates or reports its own trouble.
 */

/**
 * The largest record written, in UTF-8 bytes with its line break. A record is at most about
 * 3.5 KiB (a 256-character route template and five validated stack frames), so only a record
 * that breaks that schema is ever over this.
 */
export const MAX_RECORD_BYTES = 8 * 1024;
/**
 * The most record bytes handed to the stream and not yet reported written by it (its write
 * callback), with line breaks: the memory this writer can make the process hold, a few hundred
 * records. It does not wait for `write()` to signal backpressure, which a stream does only at its
 * own high-water mark: 64 KiB for a Linux stdout pipe on Node 24, 16 KiB for a Windows one
 * (measured), larger for streams made with a larger one. Whichever comes first stops writing.
 */
export const MAX_BUFFERED_BYTES = 64 * 1024;

export interface StreamSinkLimits {
  maxRecordBytes: number;
  maxBufferedBytes: number;
}

/**
 * - `open`: records are handed to the stream.
 * - `blocked`: the stream's last `write()` returned false; records are dropped until `drain`.
 * - `failed`: the stream reported an error or closed; every later record is dropped, for good.
 * - `closed`: the application shut down; every later record is dropped.
 */
export type StreamSinkState = 'open' | 'blocked' | 'failed' | 'closed';

/**
 * Writes each record as one line to a stream it does not own (standard output, in production).
 *
 * A record is dropped, whole, when the stream is blocked, failed or closed, when it is larger
 * than `maxRecordBytes`, or when it would take the bytes in flight past `maxBufferedBytes`.
 * Nothing is queued: a dropped record is gone, and the output does not say so.
 *
 * Errors, from a write callback, a synchronous throw or the stream's `error` event (EPIPE when
 * the reader of a pipe is gone), fail the sink permanently. The stream is never ended or
 * destroyed. The sink's `error` and `close` listeners stay attached until it is closed or failed
 * and the stream has settled every write it was handed and emitted any pending error, so a late
 * error event always has a listener; `drain` is listened to only while blocked. That is at most
 * three listeners, for as long as the stream holds writes it never settles.
 *
 * `write()` returns immediately only where the stream's own `write()` does: Node writes to files,
 * POSIX terminals and Windows pipes synchronously, so a stalled reader there stalls the process.
 */
export class StreamSink implements HttpDiagnosticsSink {
  private status: StreamSinkState = 'open';
  private inFlight = 0;
  private dropped = 0;
  private listening = true;
  /** Node emits `error` at most once per stream, and `close` after it. */
  private errorSettled = false;

  constructor(
    private readonly stream: Writable,
    private readonly limits: StreamSinkLimits = {
      maxRecordBytes: MAX_RECORD_BYTES,
      maxBufferedBytes: MAX_BUFFERED_BYTES,
    },
  ) {
    stream.on('error', this.onError);
    stream.on('close', this.onClose);
  }

  get state(): StreamSinkState {
    return this.status;
  }

  /** Record bytes handed to the stream whose write it has not yet reported settled. */
  get bufferedBytes(): number {
    return this.inFlight;
  }

  /** Records never handed to the stream (one whose write then fails is lost, but not counted). */
  get droppedRecords(): number {
    return this.dropped;
  }

  write(line: string): void {
    const chunk = `${line}\n`;
    const bytes = Buffer.byteLength(chunk);
    if (
      this.status !== 'open' ||
      bytes > this.limits.maxRecordBytes ||
      this.inFlight + bytes > this.limits.maxBufferedBytes
    ) {
      this.dropped += 1;
      return;
    }
    this.inFlight += bytes;
    let settled = false;
    const settle = (error?: unknown) => {
      if (settled) return;
      settled = true;
      this.inFlight -= bytes;
      if (error) this.fail();
      this.releaseWhenSettled();
    };
    let accepted: boolean;
    try {
      accepted = this.stream.write(chunk, settle);
    } catch (error) {
      // A stream whose write throws does not call back: count the record lost and stop.
      this.dropped += 1;
      settle(error ?? new Error('write threw'));
      return;
    }
    if (!accepted) this.block();
  }

  /**
   * Stops writing, at shutdown. Writes in flight are left to the stream, which is neither ended
   * nor destroyed (standard output is shared); listeners go as soon as nothing can reach them.
   */
  close(): void {
    this.stopWriting('closed');
  }

  /** Backpressure: one `drain` listener, unless the write already failed the sink. */
  private block() {
    if (this.status !== 'open') return;
    this.status = 'blocked';
    this.stream.once('drain', this.onDrain);
  }

  private readonly onDrain = () => {
    if (this.status === 'blocked') this.status = 'open';
  };

  private readonly onError = () => {
    this.errorSettled = true;
    this.fail();
  };

  private readonly onClose = () => {
    this.errorSettled = true;
    this.fail();
  };

  private fail() {
    if (this.status !== 'closed') this.stopWriting('failed');
    else this.releaseWhenSettled();
  }

  private stopWriting(status: 'failed' | 'closed') {
    this.status = status;
    this.stream.off('drain', this.onDrain);
    this.releaseWhenSettled();
  }

  /**
   * Detaches once stopped, with no write in flight, and with no error the stream has yet to
   * emit: Node calls a failed write's callback first, then emits `error` (once), then `close`.
   */
  private releaseWhenSettled() {
    if (!this.listening || this.status === 'open' || this.status === 'blocked') return;
    if (this.inFlight > 0 || (this.stream.errored && !this.errorSettled)) return;
    this.listening = false;
    this.stream.off('error', this.onError);
    this.stream.off('close', this.onClose);
  }
}
