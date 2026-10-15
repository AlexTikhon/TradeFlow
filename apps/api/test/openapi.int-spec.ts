import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './support/test-app.js';

/** Collects every `$ref` value anywhere in a JSON document. */
function collectRefs(node: unknown, refs: string[] = []): string[] {
  if (Array.isArray(node)) {
    node.forEach((child) => collectRefs(child, refs));
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') refs.push(value);
      else collectRefs(value, refs);
    }
  }
  return refs;
}

describe('OpenAPI document', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it('documents the voyage endpoints and every referenced schema exists', async () => {
    const response = await request(ctx.server).get('/api/docs/openapi.json').expect(200);
    const document = response.body as {
      paths: Record<string, unknown>;
      components: { schemas: Record<string, Record<string, unknown>> };
    };

    expect(Object.keys(document.paths)).toEqual(
      expect.arrayContaining([
        '/api/voyages',
        '/api/voyages/{voyageId}',
        '/api/voyages/{voyageId}/trade-string',
        '/api/voyages/{voyageId}/my-contracts',
        '/api/voyages/{voyageId}/notices',
        '/api/voyages/{voyageId}/notices/{noticeId}',
        '/api/voyages/{voyageId}/notices/{noticeId}/acknowledgement',
        '/api/vessels',
        '/api/commodities',
        '/api/ports',
      ]),
    );

    const schemaIds = new Set(Object.keys(document.components.schemas));
    const danglingRefs = collectRefs(document)
      .map((ref) => ref.replace('#/components/schemas/', ''))
      .filter((id) => !schemaIds.has(id));
    expect(danglingRefs).toEqual([]);

    for (const schema of Object.values(document.components.schemas)) {
      expect(schema).not.toHaveProperty('$id');
    }
  });

  it('documents the session cookie and which operations require it', async () => {
    const response = await request(ctx.server).get('/api/docs/openapi.json').expect(200);
    type Operation = { security?: Record<string, string[]>[]; responses: Record<string, unknown> };
    const document = response.body as {
      paths: Record<string, Record<string, Operation>>;
      components: { securitySchemes: Record<string, unknown> };
    };

    expect(document.components.securitySchemes.session).toEqual({
      type: 'apiKey',
      in: 'cookie',
      name: 'tradeflow_session',
      description: expect.any(String) as string,
    });

    const operation = (path: string, method: string) => document.paths[path]?.[method];
    const protectedOperations = [
      operation('/api/voyages', 'get'),
      operation('/api/voyages/{voyageId}', 'get'),
      operation('/api/voyages/{voyageId}/trade-string', 'get'),
      operation('/api/voyages/{voyageId}/my-contracts', 'get'),
      operation('/api/voyages/{voyageId}/notices', 'get'),
      operation('/api/voyages/{voyageId}/notices', 'post'),
      operation('/api/voyages/{voyageId}/notices/{noticeId}', 'get'),
      operation('/api/voyages/{voyageId}/notices/{noticeId}/acknowledgement', 'post'),
      operation('/api/auth/me', 'get'),
      operation('/api/voyages', 'post'),
      operation('/api/vessels', 'get'),
      operation('/api/commodities', 'get'),
      operation('/api/ports', 'get'),
    ];
    for (const op of protectedOperations) {
      expect(op?.security).toEqual([{ session: [] }]);
      expect(op?.responses).toHaveProperty('401');
    }

    for (const op of [
      operation('/api/auth/sign-in', 'post'),
      operation('/api/auth/sign-out', 'post'),
    ]) {
      expect(op).toBeDefined();
      expect(op?.security).toBeUndefined();
    }
  });

  it('documents voyage creation with a closed request schema and its failure responses', async () => {
    const response = await request(ctx.server).get('/api/docs/openapi.json').expect(200);
    type Operation = {
      requestBody?: { content: Record<string, { schema: unknown }> };
      responses: Record<string, unknown>;
    };
    const document = response.body as {
      paths: Record<string, Record<string, Operation>>;
      components: { schemas: Record<string, Record<string, unknown>> };
    };

    const create = document.paths['/api/voyages']?.post;
    expect(create?.requestBody?.content['application/json']?.schema).toEqual({
      $ref: '#/components/schemas/CreateVoyageRequest',
    });
    expect(Object.keys(create?.responses ?? {})).toEqual(
      expect.arrayContaining(['201', '400', '401', '403']),
    );
    const schema = document.components.schemas.CreateVoyageRequest;
    expect(schema?.additionalProperties).toBe(false);
    expect(schema?.required).toEqual(
      expect.arrayContaining(['vesselId', 'commodityId', 'quantity', 'loadPortId', 'laycan']),
    );
    expect(schema?.properties).not.toHaveProperty('organizationId');
  });

  it('documents the trade string as topology only, with its 404', async () => {
    const response = await request(ctx.server).get('/api/docs/openapi.json').expect(200);
    type Operation = { responses: Record<string, { content?: Record<string, unknown> }> };
    type Schema = { properties?: Record<string, unknown>; enum?: string[] };
    const document = response.body as {
      paths: Record<string, Record<string, Operation>>;
      components: { schemas: Record<string, Schema> };
    };

    const operation = document.paths['/api/voyages/{voyageId}/trade-string']?.get;
    expect(Object.keys(operation?.responses ?? {})).toEqual(
      expect.arrayContaining(['200', '400', '401', '404']),
    );
    expect(operation?.responses['200']?.content?.['application/json']).toEqual({
      schema: { $ref: '#/components/schemas/TradeString' },
    });

    const { schemas } = document.components;
    expect(Object.keys(schemas.TradeString?.properties ?? {}).sort()).toEqual(['edges', 'parties']);
    expect(Object.keys(schemas.TradeStringEdge?.properties ?? {}).sort()).toEqual([
      'buyerOrganizationId',
      'position',
      'sellerOrganizationId',
    ]);
    expect(Object.keys(schemas.TradeStringParty?.properties ?? {}).sort()).toEqual([
      'organization',
      'role',
    ]);
    expect(schemas.TradeRole?.enum).toEqual(['EXPORTER', 'TRADER', 'FINAL_BUYER']);
  });

  it('documents notices: closed request bodies, their refusals, and no notice data in the trade string', async () => {
    const response = await request(ctx.server).get('/api/docs/openapi.json').expect(200);
    type Operation = {
      requestBody?: { required?: boolean; content: Record<string, { schema: unknown }> };
      responses: Record<string, { content?: Record<string, unknown> }>;
    };
    type Schema = {
      properties?: Record<string, unknown>;
      required?: string[];
      additionalProperties?: boolean;
      enum?: string[];
    };
    const document = response.body as {
      paths: Record<string, Record<string, Operation>>;
      components: { schemas: Record<string, Schema> };
    };
    const operation = (path: string, method: string) => document.paths[path]?.[method];
    const codes = (op: Operation | undefined) => Object.keys(op?.responses ?? {});

    const issue = operation('/api/voyages/{voyageId}/notices', 'post');
    expect(issue?.requestBody?.content['application/json']?.schema).toEqual({
      $ref: '#/components/schemas/IssueNoticeRequest',
    });
    expect(codes(issue)).toEqual(expect.arrayContaining(['201', '400', '401', '403', '404']));

    const acknowledge = operation(
      '/api/voyages/{voyageId}/notices/{noticeId}/acknowledgement',
      'post',
    );
    expect(acknowledge?.requestBody?.required).toBe(false);
    expect(codes(acknowledge)).toEqual(
      expect.arrayContaining(['200', '400', '401', '403', '404', '409']),
    );
    expect(codes(operation('/api/voyages/{voyageId}/notices/{noticeId}', 'get'))).toEqual(
      expect.arrayContaining(['200', '401', '404']),
    );
    expect(
      operation('/api/voyages/{voyageId}/my-contracts', 'get')?.responses['200']?.content?.[
        'application/json'
      ],
    ).toEqual({ schema: { $ref: '#/components/schemas/CounterpartyContractListResponse' } });

    const { schemas } = document.components;
    expect(schemas.IssueNoticeRequest?.additionalProperties).toBe(false);
    expect(Object.keys(schemas.IssueNoticeRequest?.properties ?? {}).sort()).toEqual([
      'acknowledgementDueAt',
      'contractId',
      'estimatedArrivalAt',
      'message',
    ]);
    expect(schemas.IssueNoticeRequest?.required?.sort()).toEqual([
      'acknowledgementDueAt',
      'contractId',
      'estimatedArrivalAt',
    ]);
    expect(schemas.AcknowledgeNoticeRequest?.additionalProperties).toBe(false);
    expect(schemas.AcknowledgeNoticeRequest?.properties ?? {}).toEqual({});
    expect(schemas.NoticeStatus?.enum).toEqual(['ISSUED', 'ACKNOWLEDGED']);
    expect(schemas.NoticeType?.enum).toEqual(['ETA']);
    expect(Object.keys(schemas.CounterpartyContract?.properties ?? {}).sort()).toEqual([
      'buyer',
      'id',
      'position',
      'seller',
      'side',
    ]);
    // The shared topology gained nothing.
    expect(Object.keys(schemas.TradeStringEdge?.properties ?? {}).sort()).toEqual([
      'buyerOrganizationId',
      'position',
      'sellerOrganizationId',
    ]);
  });
});
