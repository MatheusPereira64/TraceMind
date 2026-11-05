import {
  mapOtlpTraces,
  nanosToIso,
  normalizeEnvironment,
  normalizeProvider,
} from './otlp.mapper.js';

const span = (overrides: Record<string, unknown>) => ({
  traceId: '0af7651916cd43dd8448eb211c80319c',
  spanId: 'b7ad6b7169203331',
  name: 'op',
  startTimeUnixNano: '1793880000000000000',
  endTimeUnixNano: '1793880000500000000',
  ...overrides,
});

const body = (
  spans: unknown[],
  resource: Array<{ key: string; value: Record<string, unknown> }> = [],
) => ({
  resourceSpans: [{ resource: { attributes: resource }, scopeSpans: [{ spans }] }],
});

const attr = (key: string, value: Record<string, unknown>) => ({ key, value });

describe('OTLP mapping', () => {
  it('converts nanosecond timestamps without precision loss', () => {
    expect(nanosToIso('1793880000123456789')).toBe('2026-11-05T12:00:00.123Z');
    expect(nanosToIso(1_000_000)).toBe('1970-01-01T00:00:00.001Z');
  });

  it.each([
    ['production', 'production'],
    ['PROD', 'production'],
    ['stage', 'staging'],
    ['local', 'development'],
    ['eu-west', undefined],
  ])('normalizes environment %s', (input, expected) => {
    expect(normalizeEnvironment(input)).toBe(expected);
  });

  it.each([
    ['openai', 'openai'],
    ['azure.ai.openai', 'openai'],
    ['gcp.vertex_ai', 'google'],
    ['aws.bedrock', 'aws.bedrock'],
    ['Weird Provider!', undefined],
  ])('normalizes provider %s', (input, expected) => {
    expect(normalizeProvider(input)).toBe(expected);
  });

  it('emits a trace event for root spans and only a span for children', () => {
    const result = mapOtlpTraces(
      body([
        span({}),
        span({ spanId: 'c7ad6b7169203331', parentSpanId: 'b7ad6b7169203331', name: 'child' }),
      ]),
    );
    expect(result.events.map((event) => event.type)).toEqual(['trace', 'span', 'span']);
    expect(result.events[2]).toMatchObject({ parentId: 'b7ad6b7169203331' });
  });

  it('treats an all-zero parent id as a root span', () => {
    const result = mapOtlpTraces(body([span({ parentSpanId: '0000000000000000' })]));
    expect(result.events[0]?.type).toBe('trace');
  });

  it('extracts GenAI attributes, legacy token names and messages from span events', () => {
    const result = mapOtlpTraces(
      body([
        span({
          parentSpanId: 'aaaaaaaaaaaaaaaa',
          attributes: [
            attr('gen_ai.system', { stringValue: 'anthropic' }),
            attr('gen_ai.request.model', { stringValue: 'req-model' }),
            attr('gen_ai.response.model', { stringValue: 'resp-model' }),
            attr('gen_ai.usage.prompt_tokens', { intValue: 12 }),
            attr('gen_ai.usage.completion_tokens', { intValue: '7' }),
            attr('gen_ai.request.max_tokens', { intValue: '256' }),
            attr('custom.flag', { boolValue: true }),
          ],
          events: [
            {
              name: 'gen_ai.content.prompt',
              attributes: [attr('gen_ai.prompt', { stringValue: '[{"role":"user"}]' })],
            },
            {
              name: 'gen_ai.content.completion',
              attributes: [attr('gen_ai.completion', { stringValue: 'plain text' })],
            },
          ],
        }),
      ]),
    );
    expect(result.events[0]).toMatchObject({
      type: 'span',
      kind: 'llm',
      provider: 'anthropic',
      model: 'resp-model',
      usage: { inputTokens: 12, outputTokens: 7 },
      modelParameters: { max_tokens: 256 },
      input: [{ role: 'user' }],
      output: 'plain text',
      metadata: { 'custom.flag': true, 'otel.source': true },
    });
  });

  it('classifies errors from status, HTTP code and exception events', () => {
    const result = mapOtlpTraces(
      body([
        span({
          parentSpanId: 'aaaaaaaaaaaaaaaa',
          attributes: [
            attr('gen_ai.operation.name', { stringValue: 'chat' }),
            attr('http.response.status_code', { intValue: '429' }),
          ],
          events: [
            {
              name: 'exception',
              attributes: [
                attr('exception.message', { stringValue: 'Rate limit reached' }),
                attr('exception.stacktrace', { stringValue: 'at call()' }),
              ],
            },
          ],
          status: { code: 2 },
        }),
        span({
          spanId: 'd7ad6b7169203331',
          parentSpanId: 'aaaaaaaaaaaaaaaa',
          attributes: [attr('gen_ai.operation.name', { stringValue: 'execute_tool' })],
          status: { code: 'STATUS_CODE_ERROR', message: 'tool crashed' },
        }),
      ]),
    );
    expect(result.events[0]).toMatchObject({
      status: 'error',
      error: {
        type: 'rate_limit',
        message: 'Rate limit reached',
        httpStatus: 429,
        stack: 'at call()',
      },
    });
    expect(result.events[1]).toMatchObject({
      kind: 'tool',
      error: { type: 'tool_call_failed', message: 'tool crashed' },
    });
  });

  it('reads environment and service from resource attributes', () => {
    const result = mapOtlpTraces(
      body(
        [span({})],
        [
          attr('deployment.environment', { stringValue: 'prod' }),
          attr('service.name', { stringValue: 'checkout' }),
        ],
      ),
    );
    expect(result.events[0]).toMatchObject({
      type: 'trace',
      environment: 'production',
      metadata: { 'service.name': 'checkout' },
    });
  });

  it('counts malformed spans as rejected without dropping the rest', () => {
    const result = mapOtlpTraces(
      body([span({}), { traceId: 'xyz', spanId: '1', name: 'bad', startTimeUnixNano: '1' }]),
    );
    expect(result.rejectedSpans).toBe(1);
    expect(result.events).toHaveLength(2);
    expect(result.errors[0]).toMatch(/traceId/);
  });

  it('never produces an end time before the start time', () => {
    const result = mapOtlpTraces(body([span({ endTimeUnixNano: '1793879999000000000' })]));
    const event = result.events[1] as { startTime: string; endTime: string };
    expect(event.endTime).toBe(event.startTime);
  });
});
