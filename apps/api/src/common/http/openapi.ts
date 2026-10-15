import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, type OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { apiSchemaRegistry } from '@tradeflow/contracts';
import { z } from 'zod';

type SchemaObjects = NonNullable<NonNullable<OpenAPIObject['components']>['schemas']>;

/** A reference to a schema published from the contracts package. */
export const schemaRef = (id: string) => ({ $ref: `#/components/schemas/${id}` });

/** Name of the security scheme for the session cookie; routes reference it via `ApiSessionAuth`. */
export const SESSION_SECURITY_SCHEME = 'session';

export interface OpenApiOptions {
  /** The session cookie's actual name, which differs between HTTP and HTTPS deployments. */
  sessionCookieName: string;
}

/**
 * Builds the OpenAPI document. Routes come from Nest's controller metadata; schemas come from
 * the shared Zod contracts, so the document cannot drift from what the API actually validates.
 */
export function createOpenApiDocument(
  app: INestApplication,
  { sessionCookieName }: OpenApiOptions,
): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('TradeFlow API')
    .setDescription('Post-trade execution for bulk commodity shipments.')
    .setVersion('0.2.0')
    .addCookieAuth(
      sessionCookieName,
      {
        type: 'apiKey',
        in: 'cookie',
        description: 'Opaque session token set by POST /api/auth/sign-in (HttpOnly).',
      },
      SESSION_SECURITY_SCHEME,
    )
    .build();

  const document = SwaggerModule.createDocument(app, config);
  const { schemas } = z.toJSONSchema(apiSchemaRegistry, {
    target: 'openapi-3.0',
    io: 'output',
    uri: (id) => schemaRef(id).$ref,
  });

  // Zod tags each schema with `$id`, which OpenAPI 3.0 schema objects do not allow.
  const components = Object.fromEntries(
    Object.entries(schemas).map(([id, { $id: _ignored, ...schema }]) => [id, schema]),
  ) as SchemaObjects;

  document.components = {
    ...document.components,
    schemas: { ...document.components?.schemas, ...components },
  };
  return document;
}

export function setupOpenApi(app: INestApplication, options: OpenApiOptions): void {
  SwaggerModule.setup('api/docs', app, () => createOpenApiDocument(app, options), {
    jsonDocumentUrl: 'api/docs/openapi.json',
  });
}
