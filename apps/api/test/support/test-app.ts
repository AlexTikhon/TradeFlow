import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';
import { PrismaService } from '../../src/infrastructure/prisma/prisma.service.js';
import { DocumentStorage } from '../../src/infrastructure/storage/document-storage.js';

export interface TestApp {
  app: INestApplication;
  /** The underlying Node server, for supertest. */
  server: Server;
  prisma: PrismaService;
}

export interface TestAppOptions {
  /** Document storage to use instead of the configured directory (a temporary one, say). */
  storage?: DocumentStorage;
}

/** Boots the real application module and HTTP pipeline against the test database. */
export async function createTestApp({ storage }: TestAppOptions = {}): Promise<TestApp> {
  const builder = Test.createTestingModule({ imports: [AppModule] });
  if (storage) {
    builder.overrideProvider(DocumentStorage).useValue(storage);
  }
  const moduleRef = await builder.compile();
  const app = configureApp(moduleRef.createNestApplication({ logger: false }));
  await app.init();
  return { app, server: app.getHttpServer() as Server, prisma: app.get(PrismaService) };
}
