import { Writable } from 'node:stream';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { MAX_BUFFERED_BYTES, MAX_RECORD_BYTES, StreamSink } from './diagnostics-sink.js';

/**
 * A destination whose writes settle only when the test says so. `chunks` is everything handed to
 * its `write()`; Node passes them to `_write` one at a time, each after the previous settles.
 */
class HeldWritable extends Writable {
  readonly chunks: string[] = [];
  private readonly held: ((error?: Error | null) => void)[] = [];

  constructor(highWaterMark = 100) {
    super({ highWaterMark, decodeStrings: false });
    const write = this.write.bind(this) as (chunk: string, callback: () => void) => boolean;
    this.write = ((chunk: string, callback: () => void) => {
      this.chunks.push(chunk);
      return write(chunk, callback);
    }) as Writable['write'];
  }

  override _write(_chunk: string, _encoding: string, callback: (error?: Error | null) => void) {
    this.held.push(callback);
  }

  /** Settles the writes handed over so far, one at a time, as the reader takes them. */
  settleAll() {
    while (this.held.length) this.held.shift()?.();
  }

  /** Fails the oldest write the way a closed pipe does. */
  failNext(code = 'EPIPE') {
    this.held.shift()?.(Object.assign(new Error(`write ${code}`), { code }));
  }

  listeners_() {
    return {
      error: this.listenerCount('error'),
      close: this.listenerCount('close'),
      drain: this.listenerCount('drain'),
    };
  }
}

/** A line of exactly `bytes` UTF-8 bytes once the sink adds its line break. */
const recordOf = (bytes: number, fill = 'a') => JSON.stringify(fill.repeat(bytes - 3));
/** Lets queued stream events (`error`, `close`, `drain`) run. */
const events = () => nextTurn();

describe('StreamSink', () => {
  it('writes whole lines and counts their UTF-8 bytes until the stream settles them', () => {
    const stream = new HeldWritable(1_000);
    const sink = new StreamSink(stream);
    sink.write('{"route":"é"}');
    expect(stream.chunks).toEqual(['{"route":"é"}\n']);
    expect(sink.bufferedBytes).toBe(15);
    stream.settleAll();
    expect(sink.bufferedBytes).toBe(0);
    expect(sink.state).toBe('open');
  });

  it('stops at backpressure, drops records while blocked, and resumes on drain', async () => {
    const stream = new HeldWritable(100);
    const sink = new StreamSink(stream);
    sink.write(recordOf(60));
    expect(sink.state).toBe('open');
    sink.write(recordOf(60)); // 120 bytes held: write() returns false.
    expect(sink.state).toBe('blocked');
    expect(stream.listeners_().drain).toBe(1);
    sink.write(recordOf(10));
    sink.write(recordOf(10));
    expect(stream.chunks).toHaveLength(2);
    expect(sink.droppedRecords).toBe(2);

    stream.settleAll();
    await events();
    expect(sink.state).toBe('open');
    expect(stream.listeners_()).toEqual({ error: 1, close: 1, drain: 0 });
    sink.write('{"after":"drain"}');
    expect(stream.chunks.at(-1)).toBe('{"after":"drain"}\n');
    expect(sink.droppedRecords).toBe(2);
  });

  it('never holds more than its byte bound, even when the stream never pushes back', () => {
    const stream = new HeldWritable(1 << 30);
    const sink = new StreamSink(stream, { maxRecordBytes: 100, maxBufferedBytes: 200 });
    for (let i = 0; i < 10; i += 1) sink.write(recordOf(60));
    expect(stream.chunks).toHaveLength(3);
    expect(sink.bufferedBytes).toBe(180);
    expect(sink.droppedRecords).toBe(7);
    expect(sink.state).toBe('open');
    stream.settleAll();
    sink.write(recordOf(60));
    expect(stream.chunks).toHaveLength(4);
  });

  it('drops an oversized record whole, never a truncated one', () => {
    const stream = new HeldWritable(1 << 30);
    const sink = new StreamSink(stream);
    sink.write(recordOf(MAX_RECORD_BYTES + 1));
    // Fewer characters than the bound, more bytes: 'é' is two bytes in UTF-8.
    sink.write(JSON.stringify('é'.repeat(MAX_RECORD_BYTES / 2)));
    sink.write('{"ok":1}');
    sink.write(recordOf(MAX_RECORD_BYTES));
    expect(sink.droppedRecords).toBe(2);
    expect(stream.chunks.map((chunk) => Buffer.byteLength(chunk))).toEqual([9, MAX_RECORD_BYTES]);
    for (const chunk of stream.chunks) expect(() => JSON.parse(chunk) as unknown).not.toThrow();
    expect(MAX_BUFFERED_BYTES).toBeGreaterThanOrEqual(4 * MAX_RECORD_BYTES);
  });

  it('fails for good on an asynchronous write error, with the error event handled', async () => {
    const stream = new HeldWritable(1_000);
    const sink = new StreamSink(stream);
    sink.write('{"n":1}');
    sink.write('{"n":2}');
    stream.failNext('EPIPE');
    expect(sink.state).toBe('failed');
    // Without the sink's listener this error event would be an uncaught exception.
    await events();
    expect(stream.destroyed).toBe(true);
    sink.write('{"n":3}');
    expect(stream.chunks).toHaveLength(2);
    expect(sink.droppedRecords).toBe(1);
    expect(sink.bufferedBytes).toBe(0);
    expect(stream.listeners_()).toEqual({ error: 0, close: 0, drain: 0 });
  });

  it('fails on an error event from the stream itself, without writing anything else', async () => {
    const stream = new HeldWritable();
    const sink = new StreamSink(stream);
    stream.destroy(Object.assign(new Error('read end closed'), { code: 'EPIPE' }));
    await events();
    expect(sink.state).toBe('failed');
    sink.write('{"n":1}');
    expect(stream.chunks).toEqual([]);
    expect(stream.listeners_()).toEqual({ error: 0, close: 0, drain: 0 });
  });

  it('fails when the stream closes, and when its write throws', async () => {
    const closing = new HeldWritable();
    const closed = new StreamSink(closing);
    closing.destroy();
    await events();
    expect(closed.state).toBe('failed');

    const throwing = new HeldWritable();
    throwing.write = () => {
      throw new Error('EBADF');
    };
    const sink = new StreamSink(throwing);
    expect(() => {
      sink.write('{"n":1}');
    }).not.toThrow();
    expect(sink.state).toBe('failed');
    expect(sink.droppedRecords).toBe(1);
    expect(sink.bufferedBytes).toBe(0);
    expect(throwing.listeners_()).toEqual({ error: 0, close: 0, drain: 0 });
  });

  it('keeps a failing stream’s listeners until its pending error has been emitted', async () => {
    const stream = new HeldWritable(1_000);
    const sink = new StreamSink(stream);
    sink.write('{"n":1}');
    stream.failNext();
    // The write's callback has run; Node emits the error on a later tick.
    expect(stream.listeners_().error).toBe(1);
    await events();
    expect(stream.listeners_().error).toBe(0);
  });

  it('stops at shutdown without ending, destroying or keeping listeners on the stream', () => {
    const stream = new HeldWritable();
    const sink = new StreamSink(stream);
    sink.write('{"n":1}');
    stream.settleAll();
    sink.close();
    sink.close();
    expect(sink.state).toBe('closed');
    expect(stream.listeners_()).toEqual({ error: 0, close: 0, drain: 0 });
    sink.write('{"n":2}');
    expect(stream.chunks).toEqual(['{"n":1}\n']);
    expect(stream.writableEnded).toBe(false);
    expect(stream.destroyed).toBe(false);
  });

  it('at shutdown while blocked, listens only until the writes in flight settle', async () => {
    const stream = new HeldWritable(100);
    const sink = new StreamSink(stream);
    sink.write(recordOf(60));
    sink.write(recordOf(60));
    expect(sink.state).toBe('blocked');
    sink.close();
    expect(stream.listeners_()).toEqual({ error: 1, close: 1, drain: 0 });
    stream.settleAll();
    await events();
    expect(sink.state).toBe('closed');
    expect(stream.listeners_()).toEqual({ error: 0, close: 0, drain: 0 });
  });

  it('handles an error from a write still in flight at shutdown', async () => {
    const stream = new HeldWritable(1_000);
    const sink = new StreamSink(stream);
    sink.write('{"n":1}');
    sink.close();
    stream.failNext();
    await events();
    expect(sink.state).toBe('closed');
    expect(stream.listeners_()).toEqual({ error: 0, close: 0, drain: 0 });
  });
});
