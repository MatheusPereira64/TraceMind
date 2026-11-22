import SwaggerParser from '@apidevtools/swagger-parser';
import { readFileSync } from 'node:fs';
import { generateOpenApi, OPENAPI_PATH, serialize } from '../../scripts/openapi.js';
import { OPERATIONS } from './operations.js';

describe('OpenAPI document', () => {
  const generated = generateOpenApi();

  it('is up to date with the schemas and contracts (run `pnpm openapi:generate`)', () => {
    expect(readFileSync(OPENAPI_PATH, 'utf8')).toBe(serialize(generated));
  });

  it('is a valid OpenAPI 3.1 document', async () => {
    await expect(
      SwaggerParser.validate(structuredClone(generated) as never),
    ).resolves.toBeDefined();
  });

  it('has unique operation ids and one entry per method and path', () => {
    const ids = OPERATIONS.map((operation) => operation.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    const routes = OPERATIONS.map((operation) => `${operation.method} ${operation.path}`);
    expect(new Set(routes).size).toBe(routes.length);
  });

  it('documents request bodies from the validation schemas', () => {
    const batch = generated.paths['/v1/ingest/batch']!.post as {
      requestBody: { content: { 'application/json': { schema: Record<string, unknown> } } };
    };
    const schema = batch.requestBody.content['application/json'].schema as {
      properties: { events: { maxItems: number; items: { oneOf: unknown[] } } };
      required: string[];
    };
    expect(schema.required).toContain('events');
    expect(schema.properties.events.maxItems).toBe(1000);
    expect(schema.properties.events.items.oneOf).toHaveLength(3);
  });

  it('flattens query schemas into parameters, keeping required ones', () => {
    const list = generated.paths['/v1/projects/{projectId}/traces']!.get as {
      parameters: Array<{ name: string; in: string; required: boolean }>;
    };
    const byName = Object.fromEntries(list.parameters.map((p) => [p.name, p]));
    expect(byName.projectId).toMatchObject({ in: 'path', required: true });
    expect(byName.from).toMatchObject({ in: 'query', required: true });
    expect(byName.limit).toMatchObject({ in: 'query', required: false });
    expect(byName.cursor).toBeDefined();
  });

  it('resolves every response contract to a component schema', () => {
    const serialized = JSON.stringify(generated);
    const refs = [...serialized.matchAll(/"#\/components\/schemas\/([^"]+)"/g)].map((m) => m[1]!);
    for (const ref of new Set(refs)) {
      expect(generated.components.schemas![ref], ref).toBeDefined();
    }
  });
});
