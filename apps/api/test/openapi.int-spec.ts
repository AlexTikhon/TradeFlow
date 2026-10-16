import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './support/test-app.js';

/** One document's path: a document type required by one instruction revision. */
const DOCUMENT =
  '/api/voyages/{voyageId}/contracts/{contractId}/documentary-instructions/revisions/{revisionNumber}/documents/{documentType}';

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
        '/api/voyages/{voyageId}/documentary-instructions',
        '/api/voyages/{voyageId}/contracts/{contractId}/documentary-instructions',
        '/api/voyages/{voyageId}/contracts/{contractId}/documentary-instructions/revisions/{revisionNumber}/acknowledgement',
        '/api/voyages/{voyageId}/documents',
        '/api/voyages/{voyageId}/contracts/{contractId}/documentary-instructions/revisions/{revisionNumber}/documents/{documentType}/versions',
        '/api/voyages/{voyageId}/contracts/{contractId}/documentary-instructions/revisions/{revisionNumber}/documents/{documentType}/versions/{versionNumber}/content',
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
      operation('/api/voyages/{voyageId}/documentary-instructions', 'get'),
      operation('/api/voyages/{voyageId}/contracts/{contractId}/documentary-instructions', 'get'),
      operation('/api/voyages/{voyageId}/contracts/{contractId}/documentary-instructions', 'put'),
      operation(
        '/api/voyages/{voyageId}/contracts/{contractId}/documentary-instructions/revisions/{revisionNumber}/acknowledgement',
        'post',
      ),
      operation('/api/voyages/{voyageId}/documents', 'get'),
      operation(`${DOCUMENT}/versions`, 'post'),
      operation(`${DOCUMENT}/versions/{versionNumber}/content`, 'get'),
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

  it('documents documentary instructions: conditional writes, their headers and refusals', async () => {
    const response = await request(ctx.server).get('/api/docs/openapi.json').expect(200);
    type Operation = {
      parameters?: { name: string; in: string; required?: boolean }[];
      requestBody?: { required?: boolean; content: Record<string, { schema: unknown }> };
      responses: Record<string, { headers?: Record<string, unknown> }>;
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
    const base = '/api/voyages/{voyageId}/contracts/{contractId}/documentary-instructions';
    const put = document.paths[base]?.put;
    const get = document.paths[base]?.get;
    const acknowledge = document.paths[`${base}/revisions/{revisionNumber}/acknowledgement`]?.post;
    const codes = (op: Operation | undefined) => Object.keys(op?.responses ?? {});
    const header = (op: Operation | undefined, name: string) =>
      op?.parameters?.find((parameter) => parameter.in === 'header' && parameter.name === name);

    expect(put?.requestBody?.content['application/json']?.schema).toEqual({
      $ref: '#/components/schemas/DocumentaryInstructionContent',
    });
    expect(codes(put)).toEqual(
      expect.arrayContaining(['200', '201', '400', '401', '403', '404', '412', '428']),
    );
    expect(header(put, 'If-Match')?.required).toBe(false);
    expect(header(put, 'If-None-Match')?.required).toBe(false);
    expect(put?.responses['200']?.headers).toHaveProperty('ETag');
    expect(put?.responses['201']?.headers).toHaveProperty('ETag');

    expect(codes(get)).toEqual(expect.arrayContaining(['200', '401', '404']));
    expect(get?.responses['200']?.headers).toHaveProperty('ETag');

    expect(codes(acknowledge)).toEqual(
      expect.arrayContaining(['200', '400', '401', '403', '404', '409', '412', '428']),
    );
    expect(header(acknowledge, 'If-Match')?.required).toBe(true);
    expect(acknowledge?.requestBody?.required).toBe(false);

    const { schemas } = document.components;
    expect(schemas.DocumentaryInstructionContent?.additionalProperties).toBe(false);
    expect(Object.keys(schemas.DocumentaryInstructionContent?.properties ?? {}).sort()).toEqual([
      'consignee',
      'notifyParty',
      'requirements',
    ]);
    expect(schemas.DocumentaryInstructionContent?.required?.sort()).toEqual([
      'consignee',
      'requirements',
    ]);
    expect(schemas.DocumentRequirement?.additionalProperties).toBe(false);
    expect(schemas.AcknowledgeRevisionRequest?.properties ?? {}).toEqual({});
    expect(schemas.RequiredDocumentType?.enum).toHaveLength(8);
    expect(Object.keys(schemas.DocumentaryInstruction?.properties ?? {}).sort()).toEqual([
      'contract',
      'currentRevision',
      'id',
      'previousRevisions',
      'version',
      'voyageId',
    ]);
  });

  it('documents documents: a multipart upload, its limits and refusals, and a binary download', async () => {
    const response = await request(ctx.server).get('/api/docs/openapi.json').expect(200);
    type Operation = {
      parameters?: { name: string; in: string; required?: boolean }[];
      requestBody?: { content: Record<string, { schema: Record<string, unknown> }> };
      responses: Record<
        string,
        { headers?: Record<string, unknown>; content?: Record<string, unknown> }
      >;
    };
    type Schema = { properties?: Record<string, unknown> };
    const document = response.body as {
      paths: Record<string, Record<string, Operation>>;
      components: { schemas: Record<string, Schema> };
    };
    const upload = document.paths[`${DOCUMENT}/versions`]?.post;
    const download = document.paths[`${DOCUMENT}/versions/{versionNumber}/content`]?.get;
    const codes = (op: Operation | undefined) => Object.keys(op?.responses ?? {});
    const header = (op: Operation | undefined, name: string) =>
      op?.parameters?.find((parameter) => parameter.in === 'header' && parameter.name === name);

    expect(Object.keys(upload?.requestBody?.content ?? {})).toEqual(['multipart/form-data']);
    expect(upload?.requestBody?.content['multipart/form-data']?.schema).toMatchObject({
      type: 'object',
      required: ['file'],
      additionalProperties: false,
      properties: { file: { type: 'string', format: 'binary' } },
    });
    expect(codes(upload)).toEqual(
      expect.arrayContaining([
        '201',
        '400',
        '401',
        '403',
        '404',
        '409',
        '412',
        '413',
        '415',
        '428',
      ]),
    );
    expect(header(upload, 'If-Match')?.required).toBe(false);
    expect(header(upload, 'If-None-Match')?.required).toBe(false);
    expect(upload?.responses['201']?.headers).toHaveProperty('ETag');
    expect(upload?.responses['201']?.headers).toHaveProperty('Location');

    expect(download?.responses['200']?.content).toEqual({
      'application/pdf': { schema: { type: 'string', format: 'binary' } },
    });
    expect(download?.responses['200']?.headers).toHaveProperty('Content-Disposition');
    expect(codes(download)).toEqual(expect.arrayContaining(['200', '400', '401', '404']));

    const { schemas } = document.components;
    expect(Object.keys(schemas.DocumentVersion?.properties ?? {}).sort()).toEqual([
      'fileName',
      'mediaType',
      'number',
      'sha256',
      'sizeBytes',
      'uploadedAt',
      'uploadedBy',
    ]);
    // Where the bytes are kept is the server's business.
    expect(JSON.stringify(schemas)).not.toMatch(/storage/i);
    expect(Object.keys(schemas.ContractDocument?.properties ?? {}).sort()).toEqual([
      'contract',
      'currentVersion',
      'documentType',
      'id',
      'previousVersions',
      'revisionNumber',
      'voyageId',
    ]);
  });
});
