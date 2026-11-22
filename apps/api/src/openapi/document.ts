import { z } from 'zod';
import { SESSION_COOKIE } from '../auth/auth.types.js';
import { OPERATIONS, type Operation } from './operations.js';

type JsonSchema = Record<string, unknown>;

export interface OpenApiDocument {
  openapi: string;
  info: Record<string, unknown>;
  paths: Record<string, Record<string, unknown>>;
  components: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

const ERROR_RESPONSES: Record<number, string> = {
  400: 'Invalid input. `issues` lists field-level problems.',
  401: 'Missing or invalid credentials.',
  403: 'Authenticated, but the role is insufficient.',
  404: 'Not found, or not visible to the caller (no existence leak across tenants).',
  413: 'Body larger than 5 MB.',
  415: 'Unsupported content type.',
  429: 'Rate limit exceeded. Retry after the `Retry-After` delay.',
  503: 'Ingestion backlog is full. Retry after the `Retry-After` delay.',
};

/** Zod → JSON Schema (2020-12, as used by OpenAPI 3.1), describing what clients send. */
export function zodToJsonSchema(schema: z.ZodType): JsonSchema {
  const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as JsonSchema;
  delete json.$schema;
  return withoutDateTimePatterns(json) as JsonSchema;
}

/** Zod adds a long validation regex next to `format: date-time`; the format alone documents it. */
function withoutDateTimePatterns(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutDateTimePatterns);
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(record)
      .filter(([key]) => !(key === 'pattern' && record.format === 'date-time'))
      .map(([key, inner]) => [key, withoutDateTimePatterns(inner)]),
  );
}

/** Flattens an object schema (or an `allOf` of object schemas) into query parameters. */
function queryParameters(schema: z.ZodType): Array<Record<string, unknown>> {
  const json = zodToJsonSchema(schema);
  const parts = (json.allOf as JsonSchema[] | undefined) ?? [json];
  const parameters = new Map<string, Record<string, unknown>>();
  for (const part of parts) {
    const properties = (part.properties ?? {}) as Record<string, JsonSchema>;
    const required = new Set((part.required as string[] | undefined) ?? []);
    for (const [name, property] of Object.entries(properties)) {
      const { description, ...propertySchema } = property;
      parameters.set(name, {
        name,
        in: 'query',
        required: required.has(name),
        ...(typeof description === 'string' ? { description } : {}),
        schema: propertySchema,
      });
    }
  }
  return [...parameters.values()];
}

function pathParameters(operation: Operation): Array<Record<string, unknown>> {
  const names = [...operation.path.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!);
  return names.map((name) => ({
    name,
    in: 'path',
    required: true,
    schema: operation.uuidParams?.includes(name)
      ? { type: 'string', format: 'uuid' }
      : { type: 'string', minLength: 1, maxLength: 128 },
  }));
}

function responseSchema(operation: Operation): JsonSchema | undefined {
  const { response } = operation;
  if ('empty' in response) return undefined;
  if ('schema' in response) return response.schema;
  const ref = { $ref: `#/components/schemas/${response.contract}` };
  return response.array ? { type: 'array', items: ref } : ref;
}

function errorStatuses(operation: Operation): number[] {
  const statuses = new Set<number>();
  if (operation.body || operation.query || operation.uuidParams?.length) statuses.add(400);
  if (operation.auth !== 'public') statuses.add(401);
  if (operation.operationId === 'register') statuses.add(403);
  if (operation.role) {
    statuses.add(403);
    statuses.add(404);
  }
  if (operation.path.includes('{traceId}') || operation.path.includes('{uid}')) statuses.add(404);
  if (operation.body) statuses.add(413);
  if (operation.path === '/v1/ingest/otlp/v1/traces') statuses.add(415);
  if (operation.path.startsWith('/v1/auth/') || operation.auth !== 'public') statuses.add(429);
  if (operation.auth === 'apiKey' && operation.method === 'post') statuses.add(503);
  return [...statuses].sort();
}

function buildOperation(operation: Operation): Record<string, unknown> {
  const parameters = [
    ...pathParameters(operation),
    ...(operation.query ? queryParameters(operation.query) : []),
    ...(operation.extraQuery ?? []).map((parameter) => ({
      name: parameter.name,
      in: 'query',
      required: false,
      description: parameter.description,
      schema: parameter.schema,
    })),
  ];

  const success = responseSchema(operation);
  const responses: Record<string, unknown> = {
    [String(operation.status)]: {
      description: success ? 'Success.' : 'Success, no content.',
      ...(success ? { content: { 'application/json': { schema: success } } } : {}),
    },
  };
  for (const status of errorStatuses(operation)) {
    responses[String(status)] = { $ref: `#/components/responses/Error${status}` };
  }

  const security =
    operation.auth === 'public'
      ? []
      : operation.auth === 'apiKey'
        ? [{ apiKey: [] }, { apiKeyHeader: [] }]
        : [{ sessionCookie: [] }, { sessionBearer: [] }];

  const description = [
    operation.description,
    operation.role
      ? `Requires the **${operation.role}** role (or higher) in the organization.`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  let requestBody: Record<string, unknown> | undefined;
  if (operation.body) {
    const isRaw = 'raw' in operation.body;
    requestBody = {
      required: true,
      ...(isRaw ? { description: (operation.body as { description: string }).description } : {}),
      content: {
        'application/json': {
          schema: isRaw
            ? (operation.body as { raw: JsonSchema }).raw
            : zodToJsonSchema(operation.body as z.ZodType),
        },
      },
    };
  }

  return {
    operationId: operation.operationId,
    tags: [operation.tag],
    summary: operation.summary,
    ...(description ? { description } : {}),
    ...(parameters.length ? { parameters } : {}),
    ...(requestBody ? { requestBody } : {}),
    responses,
    security,
  };
}

/**
 * Builds the OpenAPI 3.1 document. `contracts` holds a JSON Schema per response contract and the
 * types they reference (generated from `@tracemind/shared` by `pnpm openapi:generate`).
 */
export function buildOpenApiDocument(
  contracts: Record<string, JsonSchema>,
  version: string,
): OpenApiDocument {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const operation of OPERATIONS) {
    paths[operation.path] ??= {};
    paths[operation.path]![operation.method] = buildOperation(operation);
  }

  const missing = OPERATIONS.flatMap((operation) =>
    'contract' in operation.response && !contracts[operation.response.contract]
      ? [operation.response.contract]
      : [],
  );
  if (missing.length > 0) throw new Error(`Missing contract schemas: ${missing.join(', ')}`);

  const errorResponses = Object.fromEntries(
    Object.entries(ERROR_RESPONSES).map(([status, description]) => [
      `Error${status}`,
      {
        description,
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/ApiErrorBody' } },
        },
      },
    ]),
  );

  return {
    openapi: '3.1.0',
    info: {
      title: 'TraceMind API',
      version,
      description:
        'Observability for LLM applications: telemetry ingestion (SDK, REST and OTLP) and the ' +
        'analytics, Trace Explorer and evaluation APIs behind the dashboard.\n\n' +
        '**Authentication.** Dashboard routes use the session from `POST /v1/auth/login` ' +
        '(httpOnly cookie, or `Authorization: Bearer <token>` for scripts). Ingestion routes use ' +
        'a project API key (`Authorization: Bearer tm_<env>_…` or `X-TraceMind-Key`). The two ' +
        'are not interchangeable.\n\n' +
        '**Errors.** Every non-2xx response has the `ApiErrorBody` shape and carries a ' +
        '`requestId` that matches the `X-Request-Id` response header and the server logs.',
    },
    servers: [{ url: 'http://localhost:4000', description: 'Local development' }],
    tags: [
      { name: 'Ingestion', description: 'Send telemetry with a project API key.' },
      { name: 'Auth' },
      { name: 'Organizations' },
      { name: 'Projects' },
      { name: 'API keys' },
      { name: 'Analytics', description: 'Metrics computed from raw telemetry at query time.' },
      { name: 'Traces', description: 'Trace Explorer and prompt history.' },
      { name: 'Evaluations' },
      { name: 'Health' },
      { name: 'Docs' },
    ],
    paths,
    components: {
      securitySchemes: {
        sessionCookie: { type: 'apiKey', in: 'cookie', name: SESSION_COOKIE },
        sessionBearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        apiKey: {
          type: 'http',
          scheme: 'bearer',
          description: 'Project API key, `tm_<environment>_<32 characters>`.',
        },
        apiKeyHeader: { type: 'apiKey', in: 'header', name: 'X-TraceMind-Key' },
      },
      responses: errorResponses,
      schemas: contracts,
    },
  };
}
