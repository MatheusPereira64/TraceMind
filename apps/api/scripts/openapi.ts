/**
 * `pnpm openapi:generate` — writes openapi/openapi.json, which the API serves at
 * GET /v1/openapi.json. Request schemas come from the Zod schemas the API validates with; response
 * schemas from the TypeScript contracts in @tracemind/shared. A unit test fails when the committed
 * file is out of date, so the document cannot drift from the code.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGenerator } from 'ts-json-schema-generator';
import { buildOpenApiDocument, type OpenApiDocument } from '../src/openapi/document.js';
import { OPERATIONS } from '../src/openapi/operations.js';

type JsonSchema = Record<string, unknown>;

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
export const OPENAPI_PATH = here('../openapi/openapi.json');
const SHARED_ROOT = here('../../../packages/shared');

/** Contracts documented in every error response, in addition to the per-route ones. */
const ALWAYS = ['ApiErrorBody'];

/**
 * Points references at components and drops `additionalProperties: false`: responses may gain
 * fields in later versions, and clients should not reject them.
 */
function rewriteRefs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(rewriteRefs);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key, inner]) => !(key === 'additionalProperties' && inner === false))
        .map(([key, inner]) => [
          key,
          key === '$ref' && typeof inner === 'string'
            ? inner.replace('#/definitions/', '#/components/schemas/')
            : rewriteRefs(inner),
        ]),
    );
  }
  return value;
}

/** Recursively sorts object keys so the generated file is stable across runs. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

export function contractSchemas(): Record<string, JsonSchema> {
  const names = [
    ...new Set([
      ...ALWAYS,
      ...OPERATIONS.flatMap((operation) =>
        'contract' in operation.response ? [operation.response.contract] : [],
      ),
    ]),
  ].sort();

  const generator = createGenerator({
    path: resolve(SHARED_ROOT, 'src/index.ts'),
    tsconfig: resolve(SHARED_ROOT, 'tsconfig.json'),
    expose: 'export',
    topRef: false,
    jsDoc: 'extended',
    // Types are checked by `pnpm typecheck`; skipping here keeps generation fast.
    skipTypeCheck: true,
  });

  const schemas: Record<string, JsonSchema> = {};
  for (const name of names) {
    const {
      definitions = {},
      $schema: _ignored,
      ...root
    } = generator.createSchema(name) as JsonSchema & {
      definitions?: Record<string, JsonSchema>;
    };
    for (const [definition, schema] of Object.entries(definitions)) {
      schemas[definition] = rewriteRefs(schema) as JsonSchema;
    }
    schemas[name] = rewriteRefs(root) as JsonSchema;
  }
  return sortKeys(schemas) as Record<string, JsonSchema>;
}

export function generateOpenApi(): OpenApiDocument {
  const { version } = JSON.parse(readFileSync(here('../package.json'), 'utf8')) as {
    version: string;
  };
  return buildOpenApiDocument(contractSchemas(), version);
}

export function serialize(document: OpenApiDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeFileSync(OPENAPI_PATH, serialize(generateOpenApi()));
  console.log(`Wrote ${OPENAPI_PATH}`);
}
