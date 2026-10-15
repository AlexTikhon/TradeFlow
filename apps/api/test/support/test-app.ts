import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';
import { PrismaService } from '../../src/infrastructure/prisma/prisma.service.js';

export interface TestApp {
  app: INestApplication;
  /** The underlying Node server, for supertest. */
  server: Server;
  prisma: PrismaService;
}

/** Boots the real application module and HTTP pipeline against the test database. */
export async function createTestApp(): Promise<TestApp> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = configureApp(moduleRef.createNestApplication({ logger: false }));
  await app.init();
  return { app, server: app.getHttpServer() as Server, prisma: app.get(PrismaService) };
}
