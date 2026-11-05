import type { Environment, ErrorType, IngestEventInput, SpanKind } from '@tracemind/shared';
import { z } from 'zod';

/**
 * Maps OTLP/HTTP JSON trace exports to TraceMind ingestion events, following the OpenTelemetry
 * GenAI semantic conventions (gen_ai.*). Only the JSON encoding is supported; with the Collector,
 * configure the otlphttp exporter with `encoding: json`.
 *
 * Reference: https://opentelemetry.io/docs/specs/semconv/gen-ai/
 */

/* ------------------------------------------------------------- OTLP JSON shape */

type AnyValue = {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: string | number;
  doubleValue?: number;
  arrayValue?: { values?: AnyValue[] };
  kvlistValue?: { values?: KeyValue[] };
  bytesValue?: string;
};
type KeyValue = { key: string; value?: AnyValue };

const anyValueSchema: z.ZodType<AnyValue> = z.lazy(() =>
  z.object({
    stringValue: z.string().optional(),
    boolValue: z.boolean().optional(),
    intValue: z.union([z.string(), z.number()]).optional(),
    doubleValue: z.number().optional(),
    arrayValue: z.object({ values: z.array(anyValueSchema).optional() }).optional(),
    kvlistValue: z.object({ values: z.array(keyValueSchema).optional() }).optional(),
    bytesValue: z.string().optional(),
  }),
);
const keyValueSchema: z.ZodType<KeyValue> = z.lazy(() =>
  z.object({ key: z.string(), value: anyValueSchema.optional() }),
);
const attributes = z.array(keyValueSchema).optional();
const nanos = z.union([z.string().regex(/^\d{1,20}$/), z.number().int().nonnegative()]);

const otlpSpanSchema = z.object({
  traceId: z.string().regex(/^[0-9a-fA-F]{32}$/, 'traceId must be 32 hex characters'),
  spanId: z.string().regex(/^[0-9a-fA-F]{16}$/, 'spanId must be 16 hex characters'),
  parentSpanId: z.string().optional(),
  name: z.string().max(1_000),
  startTimeUnixNano: nanos,
  endTimeUnixNano: nanos.optional(),
  attributes,
  events: z
    .array(z.object({ name: z.string(), timeUnixNano: nanos.optional(), attributes }))
    .optional(),
  status: z
    .object({ code: z.union([z.number(), z.string()]).optional(), message: z.string().optional() })
    .optional(),
});
type OtlpSpan = z.infer<typeof otlpSpanSchema>;

export const otlpTraceRequestSchema = z.object({
  resourceSpans: z
    .array(
      z.object({
        resource: z.object({ attributes }).optional(),
        scopeSpans: z.array(z.object({ spans: z.array(z.unknown()).optional() })).optional(),
      }),
    )
    .max(1_000)
    .default([]),
});

/* ------------------------------------------------------------------ helpers */

function toPlain(value: AnyValue | undefined): unknown {
  if (!value) return undefined;
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.boolValue !== undefined) return value.boolValue;
  if (value.intValue !== undefined) {
    const parsed = Number(value.intValue);
    return Number.isSafeInteger(parsed) ? parsed : String(value.intValue);
  }
  if (value.doubleValue !== undefined) return value.doubleValue;
  if (value.arrayValue) return (value.arrayValue.values ?? []).map(toPlain);
  if (value.kvlistValue) return toRecord(value.kvlistValue.values);
  if (value.bytesValue !== undefined) return value.bytesValue;
  return undefined;
}

function toRecord(list: KeyValue[] | undefined): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const { key, value } of list ?? []) record[key] = toPlain(value);
  return record;
}

/** Nanoseconds since epoch → ISO-8601 with millisecond precision. */
export function nanosToIso(value: string | number): string {
  const ms =
    typeof value === 'number' ? Math.floor(value / 1e6) : Number(BigInt(value) / 1_000_000n);
  return new Date(ms).toISOString();
}

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;
const int = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;

function parseJsonish(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function normalizeEnvironment(value: unknown): Environment | undefined {
  const text = str(value)?.toLowerCase();
  if (!text) return undefined;
  if (['prod', 'production', 'prd'].includes(text)) return 'production';
  if (['staging', 'stage', 'stg', 'qa', 'preprod'].includes(text)) return 'staging';
  if (['dev', 'development', 'local', 'test'].includes(text)) return 'development';
  return undefined;
}

/** Maps gen_ai.provider.name / gen_ai.system values to TraceMind provider slugs. */
export function normalizeProvider(value: unknown): string | undefined {
  const text = str(value)?.toLowerCase();
  if (!text) return undefined;
  if (text === 'openai' || text === 'azure.ai.openai' || text === 'az.ai.openai') return 'openai';
  if (text === 'anthropic') return 'anthropic';
  if (text.startsWith('gcp.') || text === 'gemini' || text === 'vertex_ai' || text === 'google')
    return 'google';
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(text) ? text : undefined;
}

function spanKindFor(operation: string | undefined, isGenAi: boolean): SpanKind {
  switch (operation) {
    case 'chat':
    case 'text_completion':
    case 'generate_content':
      return 'llm';
    case 'embeddings':
      return 'embedding';
    case 'execute_tool':
      return 'tool';
    case 'invoke_agent':
    case 'create_agent':
      return 'chain';
    default:
      return isGenAi ? 'llm' : 'custom';
  }
}

function classifyError(
  attrs: Record<string, unknown>,
  message: string,
  isGenAi: boolean,
  kind: SpanKind,
): ErrorType {
  const errorType = str(attrs['error.type'])?.toLowerCase() ?? '';
  const status = int(attrs['http.response.status_code']);
  const haystack = `${errorType} ${message}`.toLowerCase();
  if (status === 429 || haystack.includes('rate limit') || haystack.includes('ratelimit'))
    return 'rate_limit';
  if (
    haystack.includes('timeout') ||
    haystack.includes('timed out') ||
    status === 408 ||
    status === 504
  )
    return 'timeout';
  if (kind === 'tool') return 'tool_call_failed';
  if (isGenAi && status !== undefined && status >= 500) return 'provider_error';
  if (status !== undefined && status >= 400) return 'api_failure';
  return isGenAi ? 'provider_error' : 'unknown';
}

const GEN_AI_PARAMETERS: Record<string, string> = {
  'gen_ai.request.temperature': 'temperature',
  'gen_ai.request.max_tokens': 'max_tokens',
  'gen_ai.request.top_p': 'top_p',
  'gen_ai.request.top_k': 'top_k',
  'gen_ai.request.frequency_penalty': 'frequency_penalty',
  'gen_ai.request.presence_penalty': 'presence_penalty',
  'gen_ai.request.seed': 'seed',
  'gen_ai.request.stop_sequences': 'stop',
};

/** Attributes consumed into first-class fields; everything else is kept as metadata. */
const CONSUMED = new Set([
  'gen_ai.provider.name',
  'gen_ai.system',
  'gen_ai.operation.name',
  'gen_ai.request.model',
  'gen_ai.response.model',
  'gen_ai.usage.input_tokens',
  'gen_ai.usage.output_tokens',
  'gen_ai.usage.prompt_tokens',
  'gen_ai.usage.completion_tokens',
  'gen_ai.input.messages',
  'gen_ai.output.messages',
  'gen_ai.system_instructions',
  'gen_ai.prompt',
  'gen_ai.completion',
  ...Object.keys(GEN_AI_PARAMETERS),
]);

const MAX_METADATA_KEYS = 100;

/* ------------------------------------------------------------------- mapping */

export interface OtlpMappingResult {
  events: IngestEventInput[];
  rejectedSpans: number;
  errors: string[];
}

export function mapOtlpTraces(body: z.infer<typeof otlpTraceRequestSchema>): OtlpMappingResult {
  const events: IngestEventInput[] = [];
  const errors: string[] = [];
  let rejectedSpans = 0;

  for (const resourceSpans of body.resourceSpans) {
    const resource = toRecord(resourceSpans.resource?.attributes);
    const environment = normalizeEnvironment(
      resource['deployment.environment.name'] ?? resource['deployment.environment'],
    );
    const service = str(resource['service.name']);

    for (const scope of resourceSpans.scopeSpans ?? []) {
      for (const rawSpan of scope.spans ?? []) {
        const parsed = otlpSpanSchema.safeParse(rawSpan);
        if (!parsed.success) {
          rejectedSpans += 1;
          if (errors.length < 10) errors.push(parsed.error.issues[0]?.message ?? 'Invalid span');
          continue;
        }
        events.push(...mapSpan(parsed.data, { environment, service }));
      }
    }
  }
  return { events, rejectedSpans, errors };
}

function mapSpan(
  span: OtlpSpan,
  resource: { environment: Environment | undefined; service: string | undefined },
): IngestEventInput[] {
  const attrs = toRecord(span.attributes);
  const traceId = span.traceId.toLowerCase();
  const spanId = span.spanId.toLowerCase();
  const parentId =
    span.parentSpanId &&
    /^[0-9a-fA-F]{16}$/.test(span.parentSpanId) &&
    !/^0+$/.test(span.parentSpanId)
      ? span.parentSpanId.toLowerCase()
      : undefined;

  const operation = str(attrs['gen_ai.operation.name']);
  const isGenAi = Object.keys(attrs).some((key) => key.startsWith('gen_ai.'));
  const kind = spanKindFor(operation, isGenAi);
  const provider = normalizeProvider(attrs['gen_ai.provider.name'] ?? attrs['gen_ai.system']);
  const model = str(attrs['gen_ai.response.model']) ?? str(attrs['gen_ai.request.model']);

  const inputTokens =
    int(attrs['gen_ai.usage.input_tokens']) ?? int(attrs['gen_ai.usage.prompt_tokens']);
  const outputTokens =
    int(attrs['gen_ai.usage.output_tokens']) ?? int(attrs['gen_ai.usage.completion_tokens']);
  const usage =
    inputTokens !== undefined || outputTokens !== undefined
      ? { inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0 }
      : undefined;

  // Messages: current conventions use attributes; older instrumentations emit span events.
  const eventAttrs = (name: string) =>
    toRecord(span.events?.find((event) => event.name === name)?.attributes);
  const systemInstructions = parseJsonish(attrs['gen_ai.system_instructions']);
  const inputMessages =
    parseJsonish(attrs['gen_ai.input.messages']) ??
    parseJsonish(attrs['gen_ai.prompt']) ??
    parseJsonish(eventAttrs('gen_ai.content.prompt')['gen_ai.prompt']);
  const input =
    systemInstructions !== undefined && inputMessages !== undefined
      ? { system: systemInstructions, messages: inputMessages }
      : (inputMessages ?? systemInstructions);
  const output =
    parseJsonish(attrs['gen_ai.output.messages']) ??
    parseJsonish(attrs['gen_ai.completion']) ??
    parseJsonish(eventAttrs('gen_ai.content.completion')['gen_ai.completion']);

  const modelParameters: Record<string, unknown> = {};
  for (const [attribute, name] of Object.entries(GEN_AI_PARAMETERS)) {
    if (attrs[attribute] !== undefined) modelParameters[name] = attrs[attribute];
  }

  const metadata: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (CONSUMED.has(key) || Object.keys(metadata).length >= MAX_METADATA_KEYS) continue;
    metadata[key] = value;
  }

  const statusCode = String(span.status?.code ?? '0');
  const isError = statusCode === '2' || statusCode === 'STATUS_CODE_ERROR';
  const exception = eventAttrs('exception');
  const errorMessage =
    str(span.status?.message) ??
    str(exception['exception.message']) ??
    str(attrs['error.type']) ??
    'Span failed';

  const startTime = nanosToIso(span.startTimeUnixNano);
  const endTime = span.endTimeUnixNano !== undefined ? nanosToIso(span.endTimeUnixNano) : undefined;
  const status = isError ? 'error' : endTime ? 'success' : 'running';

  const spanEvent: IngestEventInput = {
    type: 'span',
    id: spanId,
    traceId,
    ...(parentId ? { parentId } : {}),
    name: span.name.slice(0, 200) || '(unnamed span)',
    kind,
    ...(provider ? { provider } : {}),
    ...(model ? { model: model.slice(0, 200) } : {}),
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(Object.keys(modelParameters).length > 0 ? { modelParameters } : {}),
    metadata: { ...metadata, 'otel.source': true },
    startTime,
    ...(endTime ? { endTime: endTime < startTime ? startTime : endTime } : {}),
    status,
    ...(usage ? { usage } : {}),
    ...(isError
      ? {
          error: {
            type: classifyError(attrs, errorMessage, isGenAi, kind),
            message: errorMessage.slice(0, 10_000),
            ...(str(attrs['error.type']) ? { code: str(attrs['error.type'])!.slice(0, 200) } : {}),
            ...(int(attrs['http.response.status_code']) !== undefined
              ? { httpStatus: int(attrs['http.response.status_code'])! }
              : {}),
            ...(str(exception['exception.stacktrace'])
              ? { stack: str(exception['exception.stacktrace'])!.slice(0, 50_000) }
              : {}),
          },
        }
      : {}),
  };

  if (parentId) return [spanEvent];

  // The root span defines the trace: name, timing, status and environment.
  const traceEvent: IngestEventInput = {
    type: 'trace',
    id: traceId,
    name: span.name.slice(0, 200) || '(unnamed trace)',
    ...(resource.environment ? { environment: resource.environment } : {}),
    ...(resource.service ? { metadata: { 'service.name': resource.service } } : {}),
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    startTime,
    ...(endTime ? { endTime: endTime < startTime ? startTime : endTime } : {}),
    status,
  };
  return [traceEvent, spanEvent];
}
