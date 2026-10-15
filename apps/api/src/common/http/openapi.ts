import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, type OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { apiSchemaRegistry } from '@tradeflow/contracts';
import { z } from 'zod';

type SchemaObjects = NonNullable<NonNullable<OpenAPIObject['components']>['schemas']>;

/** A reference to a schema published from the contracts package. */
export const schemaRef = (id: string) => ({ $ref: `#/components/schemas/${id}` });

/**
 * Builds the OpenAPI document. Routes come from Nest's controller metadata; schemas come from
 * the shared Zod contracts, so the document cannot drift from what the API actually validates.
 */
export function createOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('TradeFlow API')
    .setDescription('Post-trade execution for bulk commodity shipments.')
    .setVersion('0.1.0')
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

export function setupOpenApi(app: INestApplication): void {
  SwaggerModule.setup('api/docs', app, () => createOpenApiDocument(app), {
    jsonDocumentUrl: 'api/docs/openapi.json',
  });
}
