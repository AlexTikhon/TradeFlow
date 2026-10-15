import type { INestApplication } from '@nestjs/common';
import { setupOpenApi } from './common/http/openapi.js';
import { ProblemDetailsFilter } from './common/http/problem-details.filter.js';

/**
 * HTTP pipeline configuration shared by the real server and the integration tests,
 * so tests exercise exactly the prefixes, filters and docs that production serves.
 */
export function configureApp(app: INestApplication): INestApplication {
  app.setGlobalPrefix('api');
  app.useGlobalFilters(new ProblemDetailsFilter());
  app.enableShutdownHooks();
  setupOpenApi(app);
  return app;
}
