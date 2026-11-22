import {
  analyticsQuerySchema,
  createApiKeySchema,
  createEvaluationSchema,
  createOrganizationSchema,
  createProjectSchema,
  criterionInputSchema,
  errorsQuerySchema,
  evaluationsQuerySchema,
  generationsQuerySchema,
  INGEST_MAX_EVENTS,
  ingestEventSchema,
  loginSchema,
  registerSchema,
  tracesQuerySchema,
  updateProjectSchema,
} from '@tracemind/shared';
import { z } from 'zod';

/**
 * The documented HTTP surface of the API. Request bodies and query strings are the same Zod
 * schemas the API validates with; response bodies are the TypeScript contracts in
 * `@tracemind/shared` (converted to JSON Schema by `pnpm openapi:generate`). A test fails when a
 * route exists in the API but not here, or the other way around.
 */

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

/** session: dashboard JWT (cookie or bearer) · apiKey: project key · public: none. */
export type AuthKind = 'session' | 'apiKey' | 'public';

export type ResponseBody =
  /** A contract interface exported by `@tracemind/shared`. */
  | { contract: string; array?: boolean }
  /** An inline JSON Schema, for small responses without a shared contract. */
  | { schema: Record<string, unknown> }
  | { empty: true };

export interface Operation {
  method: HttpMethod;
  /** OpenAPI path template, e.g. `/v1/projects/{projectId}`. */
  path: string;
  operationId: string;
  tag: string;
  summary: string;
  description?: string;
  auth: AuthKind;
  /** Minimum organization role, for session routes scoped to an organization or project. */
  role?: 'viewer' | 'member' | 'admin';
  /** Path parameters that must be UUIDs (others are free-form strings). */
  uuidParams?: string[];
  query?: z.ZodType;
  /** Extra query parameters not covered by `query`. */
  extraQuery?: Array<{ name: string; schema: Record<string, unknown>; description: string }>;
  body?: z.ZodType | { raw: Record<string, unknown>; description: string };
  status: number;
  response: ResponseBody;
}

/** Documentation-only view of the batch body: the API validates each event individually. */
const ingestBatchDocSchema = z.object({
  events: z.array(ingestEventSchema).min(1).max(INGEST_MAX_EVENTS),
  sdk: z.object({ name: z.string().max(100), version: z.string().max(50) }).optional(),
});

const health = (checks: boolean): Record<string, unknown> => ({
  type: 'object',
  required: checks ? ['status', 'checks'] : ['status'],
  properties: {
    status: { const: 'ok' },
    ...(checks
      ? {
          checks: {
            type: 'object',
            properties: {
              database: { enum: ['up', 'down'] },
              redis: { enum: ['up', 'down'] },
            },
          },
        }
      : {}),
  },
});

export const OPERATIONS: Operation[] = [
  /* ------------------------------------------------------------------ health */
  {
    method: 'get',
    path: '/health',
    operationId: 'getLiveness',
    tag: 'Health',
    summary: 'Liveness probe',
    auth: 'public',
    status: 200,
    response: { schema: health(false) },
  },
  {
    method: 'get',
    path: '/health/ready',
    operationId: 'getReadiness',
    tag: 'Health',
    summary: 'Readiness probe',
    description: 'Checks PostgreSQL and Redis. Answers 503 when either is unreachable.',
    auth: 'public',
    status: 200,
    response: { schema: health(true) },
  },

  /* -------------------------------------------------------------------- auth */
  {
    method: 'post',
    path: '/v1/auth/register',
    operationId: 'register',
    tag: 'Auth',
    summary: 'Create an account and its first organization',
    description:
      'Sets the httpOnly session cookie and also returns the token for scripts. Answers 403 when ' +
      'the server runs with `REGISTRATION_ENABLED=false`.',
    auth: 'public',
    body: registerSchema,
    status: 201,
    response: { contract: 'SessionDto' },
  },
  {
    method: 'post',
    path: '/v1/auth/login',
    operationId: 'login',
    tag: 'Auth',
    summary: 'Sign in',
    description: 'Sets the httpOnly session cookie and also returns the token for scripts.',
    auth: 'public',
    body: loginSchema,
    status: 200,
    response: { contract: 'SessionDto' },
  },
  {
    method: 'post',
    path: '/v1/auth/logout',
    operationId: 'logout',
    tag: 'Auth',
    summary: 'Sign out (clears the session cookie)',
    auth: 'public',
    status: 204,
    response: { empty: true },
  },
  {
    method: 'get',
    path: '/v1/auth/me',
    operationId: 'getMe',
    tag: 'Auth',
    summary: 'Current user and organizations',
    auth: 'session',
    status: 200,
    response: { contract: 'MeDto' },
  },

  /* ----------------------------------------------------------- organizations */
  {
    method: 'get',
    path: '/v1/organizations',
    operationId: 'listOrganizations',
    tag: 'Organizations',
    summary: 'Organizations of the current user',
    auth: 'session',
    status: 200,
    response: { contract: 'OrganizationDto', array: true },
  },
  {
    method: 'post',
    path: '/v1/organizations',
    operationId: 'createOrganization',
    tag: 'Organizations',
    summary: 'Create an organization (the caller becomes owner)',
    auth: 'session',
    body: createOrganizationSchema,
    status: 201,
    response: { contract: 'OrganizationDto' },
  },

  /* ---------------------------------------------------------------- projects */
  {
    method: 'get',
    path: '/v1/organizations/{organizationId}/projects',
    operationId: 'listProjects',
    tag: 'Projects',
    summary: 'Projects of an organization',
    auth: 'session',
    role: 'viewer',
    uuidParams: ['organizationId'],
    extraQuery: [
      {
        name: 'includeArchived',
        schema: { type: 'string', enum: ['true', 'false'], default: 'false' },
        description: 'Include archived projects.',
      },
    ],
    status: 200,
    response: { contract: 'ProjectDto', array: true },
  },
  {
    method: 'post',
    path: '/v1/organizations/{organizationId}/projects',
    operationId: 'createProject',
    tag: 'Projects',
    summary: 'Create a project',
    auth: 'session',
    role: 'admin',
    uuidParams: ['organizationId'],
    body: createProjectSchema,
    status: 201,
    response: { contract: 'ProjectDto' },
  },
  {
    method: 'get',
    path: '/v1/projects/{projectId}',
    operationId: 'getProject',
    tag: 'Projects',
    summary: 'Get a project',
    auth: 'session',
    role: 'viewer',
    uuidParams: ['projectId'],
    status: 200,
    response: { contract: 'ProjectDto' },
  },
  {
    method: 'patch',
    path: '/v1/projects/{projectId}',
    operationId: 'updateProject',
    tag: 'Projects',
    summary: 'Update name, description, retention or redaction settings',
    auth: 'session',
    role: 'admin',
    uuidParams: ['projectId'],
    body: updateProjectSchema,
    status: 200,
    response: { contract: 'ProjectDto' },
  },
  {
    method: 'delete',
    path: '/v1/projects/{projectId}',
    operationId: 'archiveProject',
    tag: 'Projects',
    summary: 'Archive a project',
    description:
      'Stops accepting telemetry and revokes its API keys. Data stays readable until the retention job removes it.',
    auth: 'session',
    role: 'admin',
    uuidParams: ['projectId'],
    status: 200,
    response: { contract: 'ProjectDto' },
  },
  {
    method: 'get',
    path: '/v1/projects/{projectId}/ingestion',
    operationId: 'getIngestionStatus',
    tag: 'Projects',
    summary: 'Telemetry received by a project and recent ingestion failures',
    auth: 'session',
    role: 'viewer',
    uuidParams: ['projectId'],
    status: 200,
    response: { contract: 'IngestionStatusDto' },
  },

  /* ---------------------------------------------------------------- api keys */
  {
    method: 'get',
    path: '/v1/projects/{projectId}/api-keys',
    operationId: 'listApiKeys',
    tag: 'API keys',
    summary: 'API keys of a project (never the secret)',
    auth: 'session',
    role: 'viewer',
    uuidParams: ['projectId'],
    status: 200,
    response: { contract: 'ApiKeyDto', array: true },
  },
  {
    method: 'post',
    path: '/v1/projects/{projectId}/api-keys',
    operationId: 'createApiKey',
    tag: 'API keys',
    summary: 'Create an API key',
    description: 'The plaintext key is returned only in this response; only its hash is stored.',
    auth: 'session',
    role: 'admin',
    uuidParams: ['projectId'],
    body: createApiKeySchema,
    status: 201,
    response: { contract: 'CreatedApiKeyDto' },
  },
  {
    method: 'delete',
    path: '/v1/projects/{projectId}/api-keys/{keyId}',
    operationId: 'revokeApiKey',
    tag: 'API keys',
    summary: 'Revoke an API key',
    auth: 'session',
    role: 'admin',
    uuidParams: ['projectId', 'keyId'],
    status: 200,
    response: { contract: 'ApiKeyDto' },
  },

  /* --------------------------------------------------------------- ingestion */
  {
    method: 'get',
    path: '/v1/ingest/whoami',
    operationId: 'whoami',
    tag: 'Ingestion',
    summary: 'Validate an API key',
    description: 'Returns the project, organization and default environment the key is bound to.',
    auth: 'apiKey',
    status: 200,
    response: {
      schema: {
        type: 'object',
        required: ['projectId', 'organizationId', 'environment'],
        properties: {
          projectId: { type: 'string', format: 'uuid' },
          organizationId: { type: 'string', format: 'uuid' },
          environment: { enum: ['development', 'staging', 'production'] },
        },
      },
    },
  },
  {
    method: 'post',
    path: '/v1/ingest/batch',
    operationId: 'ingestBatch',
    tag: 'Ingestion',
    summary: 'Send trace, span and evaluation events',
    description:
      'Up to 1000 events per request. Every event is an idempotent upsert keyed by its client id. ' +
      'Events are validated individually: valid ones are queued (202) even when others are ' +
      'rejected, and `rejected` lists each invalid event by index. Answers 503 with Retry-After ' +
      'when the ingestion backlog is full.',
    auth: 'apiKey',
    body: ingestBatchDocSchema,
    status: 202,
    response: { contract: 'IngestBatchResponse' },
  },
  {
    method: 'post',
    path: '/v1/ingest/otlp/v1/traces',
    operationId: 'ingestOtlpTraces',
    tag: 'Ingestion',
    summary: 'OTLP/HTTP trace export (JSON encoding)',
    description:
      'Accepts `ExportTraceServiceRequest` in OTLP/JSON. GenAI semantic-convention attributes ' +
      '(`gen_ai.*`) become LLM spans with token usage and cost. Protobuf is not supported (415).',
    auth: 'apiKey',
    body: {
      raw: {
        type: 'object',
        properties: { resourceSpans: { type: 'array', items: { type: 'object' } } },
      },
      description: 'OTLP ExportTraceServiceRequest, JSON encoding.',
    },
    status: 200,
    response: {
      schema: {
        type: 'object',
        properties: {
          partialSuccess: {
            type: 'object',
            properties: {
              rejectedSpans: { type: 'integer' },
              errorMessage: { type: 'string' },
            },
          },
        },
      },
    },
  },

  /* --------------------------------------------------------------- analytics */
  ...(
    [
      [
        'overview',
        'getOverview',
        'Totals and latency percentiles, with the previous period',
        'OverviewDto',
      ],
      [
        'timeseries',
        'getTimeseries',
        'Requests, tokens, cost and latency per interval',
        'TimeseriesDto',
      ],
      ['costs', 'getCosts', 'Spend by model, token type and most expensive requests', 'CostsDto'],
      [
        'performance',
        'getPerformance',
        'Latency percentiles, distribution and slowest calls',
        'PerformanceDto',
      ],
      [
        'dimensions',
        'getDimensions',
        'Environments, providers and models seen in the project',
        'DimensionsDto',
      ],
    ] as const
  ).map(([name, operationId, summary, contract]): Operation => ({
    method: 'get',
    path: `/v1/projects/{projectId}/analytics/${name}`,
    operationId,
    tag: 'Analytics',
    summary,
    auth: 'session',
    role: 'viewer',
    uuidParams: ['projectId'],
    ...(name === 'dimensions' ? {} : { query: analyticsQuerySchema }),
    status: 200,
    response: { contract },
  })),
  {
    method: 'get',
    path: '/v1/projects/{projectId}/analytics/breakdown',
    operationId: 'getBreakdown',
    tag: 'Analytics',
    summary: 'Usage and cost grouped by model or provider',
    auth: 'session',
    role: 'viewer',
    uuidParams: ['projectId'],
    query: analyticsQuerySchema,
    extraQuery: [
      {
        name: 'by',
        schema: { type: 'string', enum: ['model', 'provider'], default: 'model' },
        description: 'Grouping dimension.',
      },
    ],
    status: 200,
    response: { contract: 'BreakdownRow', array: true },
  },
  {
    method: 'get',
    path: '/v1/projects/{projectId}/analytics/errors',
    operationId: 'getErrors',
    tag: 'Analytics',
    summary: 'Errors over time by type, with their traces',
    auth: 'session',
    role: 'viewer',
    uuidParams: ['projectId'],
    query: errorsQuerySchema,
    status: 200,
    response: { contract: 'ErrorsDto' },
  },
  {
    method: 'get',
    path: '/v1/pricing',
    operationId: 'listPricing',
    tag: 'Analytics',
    summary: 'Model price registry used for cost estimates',
    auth: 'session',
    status: 200,
    response: { contract: 'PricingRowDto', array: true },
  },

  /* ------------------------------------------------------- traces & prompts */
  {
    method: 'get',
    path: '/v1/projects/{projectId}/traces',
    operationId: 'listTraces',
    tag: 'Traces',
    summary: 'Search and filter traces (keyset pagination)',
    auth: 'session',
    role: 'viewer',
    uuidParams: ['projectId'],
    query: tracesQuerySchema,
    status: 200,
    response: { contract: 'TracesPage' },
  },
  {
    method: 'get',
    path: '/v1/projects/{projectId}/traces/{traceId}',
    operationId: 'getTrace',
    tag: 'Traces',
    summary: 'A trace with its span tree, errors and evaluations',
    description: '`traceId` is the client id sent at ingestion (1–128 characters).',
    auth: 'session',
    role: 'viewer',
    uuidParams: ['projectId'],
    status: 200,
    response: { contract: 'TraceDetailDto' },
  },
  {
    method: 'get',
    path: '/v1/projects/{projectId}/generations',
    operationId: 'listGenerations',
    tag: 'Traces',
    summary: 'Prompt history: every LLM call with its prompt and answer',
    auth: 'session',
    role: 'viewer',
    uuidParams: ['projectId'],
    query: generationsQuerySchema,
    status: 200,
    response: { contract: 'GenerationsPage' },
  },
  {
    method: 'get',
    path: '/v1/projects/{projectId}/generations/{uid}',
    operationId: 'getGeneration',
    tag: 'Traces',
    summary: 'One LLM call in full',
    auth: 'session',
    role: 'viewer',
    uuidParams: ['projectId', 'uid'],
    status: 200,
    response: { contract: 'GenerationDetailDto' },
  },
  {
    method: 'get',
    path: '/v1/projects/{projectId}/prompts/repeated',
    operationId: 'listRepeatedPrompts',
    tag: 'Traces',
    summary: 'Identical prompts sent more than once (caching candidates)',
    auth: 'session',
    role: 'viewer',
    uuidParams: ['projectId'],
    query: analyticsQuerySchema,
    status: 200,
    response: { contract: 'RepeatedPromptDto', array: true },
  },

  /* ------------------------------------------------------------- evaluations */
  {
    method: 'get',
    path: '/v1/projects/{projectId}/evaluation-criteria',
    operationId: 'listCriteria',
    tag: 'Evaluations',
    summary: 'Evaluation criteria definitions',
    auth: 'session',
    role: 'viewer',
    uuidParams: ['projectId'],
    status: 200,
    response: { contract: 'CriterionDto', array: true },
  },
  {
    method: 'post',
    path: '/v1/projects/{projectId}/evaluation-criteria',
    operationId: 'createCriterion',
    tag: 'Evaluations',
    summary: 'Define a criterion (scale or labels)',
    auth: 'session',
    role: 'admin',
    uuidParams: ['projectId'],
    body: criterionInputSchema,
    status: 201,
    response: { contract: 'CriterionDto' },
  },
  {
    method: 'put',
    path: '/v1/projects/{projectId}/evaluation-criteria/{criterionId}',
    operationId: 'updateCriterion',
    tag: 'Evaluations',
    summary: 'Replace a criterion definition',
    auth: 'session',
    role: 'admin',
    uuidParams: ['projectId', 'criterionId'],
    body: criterionInputSchema,
    status: 200,
    response: { contract: 'CriterionDto' },
  },
  {
    method: 'delete',
    path: '/v1/projects/{projectId}/evaluation-criteria/{criterionId}',
    operationId: 'deleteCriterion',
    tag: 'Evaluations',
    summary: 'Delete a criterion definition (scores are kept)',
    auth: 'session',
    role: 'admin',
    uuidParams: ['projectId', 'criterionId'],
    status: 204,
    response: { empty: true },
  },
  {
    method: 'post',
    path: '/v1/projects/{projectId}/traces/{traceId}/evaluations',
    operationId: 'createEvaluation',
    tag: 'Evaluations',
    summary: 'Score a trace or one of its spans as a reviewer',
    description: 'Idempotent per reviewer, target and criterion: scoring again updates the score.',
    auth: 'session',
    role: 'member',
    uuidParams: ['projectId'],
    body: createEvaluationSchema,
    status: 201,
    response: { contract: 'EvaluationDto' },
  },
  {
    method: 'delete',
    path: '/v1/projects/{projectId}/evaluations/{evaluationId}',
    operationId: 'deleteEvaluation',
    tag: 'Evaluations',
    summary: 'Delete an evaluation',
    description: 'Members can delete their own scores; admins can delete any.',
    auth: 'session',
    role: 'member',
    uuidParams: ['projectId', 'evaluationId'],
    status: 204,
    response: { empty: true },
  },
  {
    method: 'get',
    path: '/v1/projects/{projectId}/evaluations',
    operationId: 'listEvaluations',
    tag: 'Evaluations',
    summary: 'Evaluation history',
    auth: 'session',
    role: 'viewer',
    uuidParams: ['projectId'],
    query: evaluationsQuerySchema,
    status: 200,
    response: { contract: 'EvaluationsPage' },
  },
  {
    method: 'get',
    path: '/v1/projects/{projectId}/evaluations/summary',
    operationId: 'getEvaluationSummary',
    tag: 'Evaluations',
    summary: 'Per-criterion averages, distributions and trends',
    auth: 'session',
    role: 'viewer',
    uuidParams: ['projectId'],
    query: evaluationsQuerySchema,
    status: 200,
    response: { contract: 'EvaluationSummaryDto' },
  },

  /* ------------------------------------------------------------------- docs */
  {
    method: 'get',
    path: '/v1/openapi.json',
    operationId: 'getOpenApiDocument',
    tag: 'Docs',
    summary: 'This OpenAPI document',
    auth: 'public',
    status: 200,
    response: { schema: { type: 'object' } },
  },
];
