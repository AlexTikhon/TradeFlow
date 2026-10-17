import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';
import { PrismaService } from '../../src/infrastructure/prisma/prisma.service.js';
import { DocumentStorage } from '../../src/infrastructure/storage/document-storage.js';
import { VoyageEventBus } from '../../src/modules/voyages/voyage-event-bus.js';
import {
  VOYAGE_EVENT_STREAM_OPTIONS,
  type VoyageEventStreamOptions,
} from '../../src/modules/voyages/voyage-event-streams.js';

export interface TestApp {
  app: INestApplication;
  /** The underlying Node server, for supertest. */
  server: Server;
  prisma: PrismaService;
}

export interface TestAppOptions {
  /** Document storage to use instead of the configured directory (a temporary one, say). */
  storage?: DocumentStorage;
  /** The event bus to use instead of the plain one (one that can be made to fail, say). */
  eventBus?: VoyageEventBus;
  /** Event stream options instead of the defaults. Read when the first stream opens. */
  eventStreams?: VoyageEventStreamOptions;
}

/** Boots the real application module and HTTP pipeline against the test database. */
export async function createTestApp({
  storage,
  eventBus,
  eventStreams,
}: TestAppOptions = {}): Promise<TestApp> {
  const builder = Test.createTestingModule({ imports: [AppModule] });
  if (storage) {
    builder.overrideProvider(DocumentStorage).useValue(storage);
  }
  if (eventBus) {
    builder.overrideProvider(VoyageEventBus).useValue(eventBus);
  }
  if (eventStreams) {
    builder.overrideProvider(VOYAGE_EVENT_STREAM_OPTIONS).useValue(eventStreams);
  }
  const moduleRef = await builder.compile();
  const app = configureApp(moduleRef.createNestApplication({ logger: false }));
  await app.init();
  return { app, server: app.getHttpServer() as Server, prisma: app.get(PrismaService) };
}
