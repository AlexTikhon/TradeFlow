import { createServer } from 'node:http';
import { Global, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { StreamSink } from '../../src/common/http/diagnostics-sink.js';
import {
  HTTP_DIAGNOSTICS_SINK,
  HttpDiagnostics,
  HttpDiagnosticsModule,
} from '../../src/common/http/http-diagnostics.js';
import { APP_CONFIG } from '../../src/config/app-config.js';

/*
 * A child process for diagnostics-sink.process.spec.ts (`node --import tsx`): the production
 * HttpDiagnosticsModule, so the production sink on this process's real standard output, in front
 * of a node:http server. Standard output carries only the records. The port, the sink's state
 * and shutdown go over the IPC channel.
 *
 * GET /state answers the sink's state and standard output's own buffered bytes as JSON; any
 * other request answers `ok`. Every request gets its record, as in the application.
 */

@Global()
@Module({
  providers: [{ provide: APP_CONFIG, useValue: { httpRequestLog: true } }],
  exports: [APP_CONFIG],
})
class ConfigStubModule {}

@Module({ imports: [ConfigStubModule, HttpDiagnosticsModule] })
class SinkProbeModule {}

export interface SinkProbeState {
  state: StreamSink['state'];
  bufferedBytes: number;
  droppedRecords: number;
  /** `process.stdout.writableLength`: every byte standard output holds, ours or not. */
  stdoutBufferedBytes: number;
  /** Listeners added to standard output since this process started: the sink's. */
  stdoutListeners: { error: number; close: number; drain: number };
}

// Under tsx, standard output already has an `error` listener (a pipe's): not the sink's.
const EVENTS = ['error', 'close', 'drain'] as const;
const startupListeners = new Map(
  EVENTS.map((event) => [event, new Set(process.stdout.listeners(event))]),
);
const addedListeners = (event: (typeof EVENTS)[number]) =>
  process.stdout.listeners(event).filter((listener) => !startupListeners.get(event)?.has(listener))
    .length;

export type SinkProbeMessage =
  { type: 'listening'; port: number } | { type: 'closed'; state: SinkProbeState };

const context = await NestFactory.createApplicationContext(SinkProbeModule, { logger: false });
const diagnostics = context.get(HttpDiagnostics);
const sink = context.get<StreamSink>(HTTP_DIAGNOSTICS_SINK);

const probeState = (): SinkProbeState => ({
  state: sink.state,
  bufferedBytes: sink.bufferedBytes,
  droppedRecords: sink.droppedRecords,
  stdoutBufferedBytes: process.stdout.writableLength,
  stdoutListeners: {
    error: addedListeners('error'),
    close: addedListeners('close'),
    drain: addedListeners('drain'),
  },
});

const server = createServer((request, response) => {
  diagnostics.middleware(request, response, () => {
    if (request.url === '/state') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(probeState()));
    } else {
      response.end('ok');
    }
  });
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (address && typeof address === 'object') {
    process.send?.({ type: 'listening', port: address.port } satisfies SinkProbeMessage);
  }
});

let stopping = false;
const stop = async () => {
  stopping = true;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await context.close();
};

process.on('message', (message) => {
  if (message !== 'shutdown' || stopping) return;
  void stop().then(() => {
    process.send?.({ type: 'closed', state: probeState() } satisfies SinkProbeMessage, () => {
      process.disconnect();
    });
  });
});
// The parent is gone: nothing else will stop this process.
process.on('disconnect', () => {
  if (!stopping) void stop();
});
