import type { INestApplication } from '@nestjs/common';
import type { Application, NextFunction, Request, Response } from 'express';
import { setupOpenApi } from './common/http/openapi.js';
import { ProblemDetailsFilter } from './common/http/problem-details.filter.js';
import { SessionCookie } from './modules/auth/session-cookie.js';

/**
 * HTTP pipeline configuration shared by the real server and the integration tests,
 * so tests exercise exactly the prefixes, filters and docs that production serves.
 */
export function configureApp(app: INestApplication): INestApplication {
  app.setGlobalPrefix('api');
  // Entity tags mean "this version of an aggregate" and are set explicitly where writes are
  // conditional (ADR 0012). Express's automatic body-hash tags would look usable in If-Match
  // without ever matching, and no-store responses gain nothing from them.
  (app.getHttpAdapter().getInstance() as Application).set('etag', false);
  // API responses depend on who is signed in: no browser or intermediary may cache them and
  // serve one identity's data to the next.
  app.use('/api', (_request: Request, response: Response, next: NextFunction) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.useGlobalFilters(new ProblemDetailsFilter());
  app.enableShutdownHooks();
  setupOpenApi(app, { sessionCookieName: app.get(SessionCookie).name });
  return app;
}
