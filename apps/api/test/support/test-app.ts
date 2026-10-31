import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';
import { APP_CONFIG, type AppConfig } from '../../src/config/app-config.js';
import { PrismaService } from '../../src/infrastructure/prisma/prisma.service.js';
import { DocumentStorage } from '../../src/infrastructure/storage/document-storage.js';
import {
  ACTION_CENTER_CLOCK,
  type Clock,
} from '../../src/modules/action-center/action-center.service.js';
import {
  DEFAULT_SIGN_IN_ADMISSION_OPTIONS,
  SIGN_IN_ADMISSION_OPTIONS,
  type SignInAdmissionOptions,
} from '../../src/modules/auth/sign-in-admission.js';
import { VoyageEventBus } from '../../src/modules/voyages/voyage-event-bus.js';
import {
  VOYAGE_EVENT_STREAM_OPTIONS,
  type VoyageEventStreamOptions,
} from '../../src/modules/voyages/voyage-event-streams.js';

/**
 * Sign-in admission for suites that do not test it. Every request in these suites comes from one
 * loopback address, and many sign in a dozen users per test, which would spend the production
 * budget (20 a minute) on setup. Only that budget is raised: the guard, window, storage bound and
 * concurrency cap are the production ones. The admission suite passes the production options.
 */
const SUITE_SIGN_IN_ADMISSION: SignInAdmissionOptions = {
  ...DEFAULT_SIGN_IN_ADMISSION_OPTIONS,
  attemptsPerWindow: 10_000,
};

export interface TestApp {
  app: INestApplication;
  /** The underlying Node server, for supertest. */
  server: Server;
  prisma: PrismaService;
}

export interface TestAppOptions {
  config?: AppConfig;
  /** Document storage to use instead of the configured directory (a temporary one, say). */
  storage?: DocumentStorage;
  /** The event bus to use instead of the plain one (one that can be made to fail, say). */
  eventBus?: VoyageEventBus;
  /** Event stream options instead of the defaults. Read when the first stream opens. */
  eventStreams?: VoyageEventStreamOptions;
  /** The Action Center's clock instead of the real one (one a test can set, say). */
  actionCenterClock?: Clock;
  /** Sign-in admission options instead of the suites' default (see SUITE_SIGN_IN_ADMISSION). */
  signInAdmission?: SignInAdmissionOptions;
}

/** Boots the real application module and HTTP pipeline against the test database. */
export async function createTestApp({
  config,
  storage,
  eventBus,
  eventStreams,
  actionCenterClock,
  signInAdmission = SUITE_SIGN_IN_ADMISSION,
}: TestAppOptions = {}): Promise<TestApp> {
  const builder = Test.createTestingModule({ imports: [AppModule] });
  if (config) builder.overrideProvider(APP_CONFIG).useValue(config);
  builder.overrideProvider(SIGN_IN_ADMISSION_OPTIONS).useValue(signInAdmission);
  if (storage) {
    builder.overrideProvider(DocumentStorage).useValue(storage);
  }
  if (eventBus) {
    builder.overrideProvider(VoyageEventBus).useValue(eventBus);
  }
  if (eventStreams) {
    builder.overrideProvider(VOYAGE_EVENT_STREAM_OPTIONS).useValue(eventStreams);
  }
  if (actionCenterClock) {
    builder.overrideProvider(ACTION_CENTER_CLOCK).useValue(actionCenterClock);
  }
  const moduleRef = await builder.compile();
  const app = configureApp(moduleRef.createNestApplication({ logger: false }));
  await app.init();
  return { app, server: app.getHttpServer() as Server, prisma: app.get(PrismaService) };
}
