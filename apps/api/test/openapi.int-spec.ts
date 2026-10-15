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
      expect.arrayContaining(['/api/voyages', '/api/voyages/{voyageId}']),
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
});
