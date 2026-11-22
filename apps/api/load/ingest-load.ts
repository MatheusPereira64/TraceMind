/**
 * Ingestion load test: `pnpm load:ingest [options]`.
 *
 * Creates a throwaway account, project and API key on the target API, then sends batches to
 * POST /v1/ingest/batch with autocannon for a fixed duration. It measures two things:
 *
 * 1. Acceptance — HTTP throughput and latency of the ingestion endpoint (validation, redaction,
 *    enqueue). This is what an instrumented application waits on.
 * 2. Persistence — how long the queue workers take to write everything that was accepted to
 *    PostgreSQL, read back through the project's ingestion status.
 *
 * The target API needs a higher per-key limit than the default (600 req/min), e.g.
 * INGEST_RATE_LIMIT_PER_MINUTE=1000000, and AUTH_RATE_LIMIT_PER_MINUTE high enough for setup.
 * Every run creates a new project, so results never mix with real telemetry.
 */
import autocannon from 'autocannon';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { cpus, totalmem } from 'node:os';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://localhost:4000' },
    duration: { type: 'string', default: '30' },
    connections: { type: 'string', default: '20' },
    'traces-per-batch': { type: 'string', default: '10' },
    'spans-per-trace': { type: 'string', default: '4' },
    /** Cap on requests per second across all connections (default: as fast as possible). */
    rate: { type: 'string' },
    'drain-timeout': { type: 'string', default: '600' },
    out: { type: 'string' },
  },
});

const baseUrl = values.url.replace(/\/$/, '');
const duration = Number(values.duration);
const connections = Number(values.connections);
const tracesPerBatch = Number(values['traces-per-batch']);
const spansPerTrace = Number(values['spans-per-trace']);
const eventsPerBatch = tracesPerBatch * (1 + spansPerTrace);
const drainTimeoutMs = Number(values['drain-timeout']) * 1000;
const rate = values.rate ? Number(values.rate) : undefined;

async function api<T>(path: string, init: RequestInit & { token?: string } = {}): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
    },
  });
  if (!response.ok) throw new Error(`${path} → ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

async function setup() {
  const session = await api<{ accessToken: string; organizations: Array<{ id: string }> }>(
    '/v1/auth/register',
    {
      method: 'POST',
      body: JSON.stringify({
        name: 'Load test',
        email: `load-${randomUUID().slice(0, 8)}@example.com`,
        password: `load-test-${randomUUID()}`,
        organizationName: 'Load test',
      }),
    },
  );
  const token = session.accessToken;
  const project = await api<{ id: string }>(
    `/v1/organizations/${session.organizations[0]!.id}/projects`,
    {
      method: 'POST',
      token,
      body: JSON.stringify({ name: `Load ${new Date().toISOString().slice(0, 19)}` }),
    },
  );
  const key = await api<{ key: string }>(`/v1/projects/${project.id}/api-keys`, {
    method: 'POST',
    token,
    body: JSON.stringify({ name: 'load-test', environment: 'production' }),
  });
  return { token, projectId: project.id, key: key.key };
}

const MODELS = [
  ['openai', 'gpt-6-luna'],
  ['anthropic', 'claude-sonnet-5-5'],
  ['google', 'gemini-3.8-flash'],
] as const;

/** One realistic batch: traces of an agent run with nested LLM and tool spans. */
function batch(): string {
  const now = Date.now();
  const events: unknown[] = [];
  for (let t = 0; t < tracesPerBatch; t += 1) {
    const traceId = randomUUID();
    const start = now - 5_000;
    events.push({
      type: 'trace',
      id: traceId,
      name: 'support-agent',
      userId: `user-${t % 50}`,
      tags: ['load-test'],
      input: { question: 'Where is my order? My email is someone@example.com' },
      output: { answer: 'It shipped yesterday.' },
      startTime: new Date(start).toISOString(),
      endTime: new Date(start + 2_000).toISOString(),
    });
    for (let s = 0; s < spansPerTrace; s += 1) {
      const [provider, model] = MODELS[s % MODELS.length]!;
      const llm = s % 2 === 0;
      events.push({
        type: 'span',
        id: randomUUID(),
        traceId,
        name: llm ? 'generate' : 'lookup',
        kind: llm ? 'llm' : 'tool',
        ...(llm
          ? {
              provider,
              model,
              input: [{ role: 'user', content: `Question ${s} about order ${t}` }],
              output: { role: 'assistant', content: 'A short answer.' },
              usage: { inputTokens: 800 + s * 10, outputTokens: 120, cachedInputTokens: 200 },
            }
          : { input: { orderId: t }, output: { status: 'shipped' } }),
        startTime: new Date(start + s * 100).toISOString(),
        endTime: new Date(start + s * 100 + 400).toISOString(),
      });
    }
  }
  return JSON.stringify({ events, sdk: { name: 'load-test', version: '1' } });
}

async function waitForDrain(
  projectId: string,
  token: string,
  expected: { traces: number; spans: number },
) {
  const started = Date.now();
  for (;;) {
    const status = await api<{ traceCount: number; spanCount: number }>(
      `/v1/projects/${projectId}/ingestion`,
      { token },
    );
    if (status.traceCount >= expected.traces && status.spanCount >= expected.spans) {
      return { ...status, drainMs: Date.now() - started };
    }
    if (Date.now() - started > drainTimeoutMs) {
      return { ...status, drainMs: Date.now() - started, timedOut: true };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function main(): Promise<void> {
  const { token, projectId, key } = await setup();
  console.log(
    `Project ${projectId}: ${connections} connections, ${duration}s, ` +
      `${eventsPerBatch} events per batch (${tracesPerBatch} traces × ${spansPerTrace} spans)` +
      (rate ? `, capped at ${rate} req/s` : ''),
  );

  const loadStarted = Date.now();
  const result = await autocannon({
    url: `${baseUrl}/v1/ingest/batch`,
    method: 'POST',
    connections,
    duration,
    ...(rate ? { overallRate: rate } : {}),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    requests: [{ setupRequest: (request) => ({ ...request, body: batch() }) }],
  });
  const loadMs = Date.now() - loadStarted;
  const statusCodes = Object.fromEntries(
    Object.entries(result.statusCodeStats ?? {}).map(([code, stats]) => [code, stats.count]),
  ) as Record<string, number>;
  // Every 202 carries a full batch of valid events (the generator never sends invalid ones).
  const acceptedBatches = statusCodes['202'] ?? 0;
  const accepted = acceptedBatches * eventsPerBatch;
  const expected = {
    traces: acceptedBatches * tracesPerBatch,
    spans: acceptedBatches * tracesPerBatch * spansPerTrace,
  };
  const drained = await waitForDrain(projectId, token, expected);
  const totalMs = loadMs + drained.drainMs;

  const report = {
    date: new Date().toISOString(),
    machine: {
      cpus: cpus().length,
      cpuModel: cpus()[0]?.model,
      memoryGb: Math.round(totalmem() / 2 ** 30),
    },
    config: {
      connections,
      durationSeconds: duration,
      rate: rate ?? 'max',
      tracesPerBatch,
      spansPerTrace,
      eventsPerBatch,
    },
    http: {
      requests: result.requests.total,
      requestsPerSecond: result.requests.average,
      latencyMs: {
        p50: result.latency.p50,
        p90: result.latency.p90,
        p99: result.latency.p99,
        max: result.latency.max,
      },
      statusCodes,
      errors: result.errors,
      timeouts: result.timeouts,
      non2xx: result.non2xx,
    },
    ingestion: {
      eventsAccepted: accepted,
      eventsAcceptedPerSecond: Math.round(accepted / (loadMs / 1000)),
      tracesPersisted: drained.traceCount,
      spansPersisted: drained.spanCount,
      expected,
      drainAfterLoadMs: drained.drainMs,
      eventsPersistedPerSecond: Math.round(
        (drained.traceCount + drained.spanCount) / (totalMs / 1000),
      ),
      complete: !('timedOut' in drained),
    },
  };

  console.table({
    'HTTP requests/s': report.http.requestsPerSecond,
    'Latency p50 (ms)': report.http.latencyMs.p50,
    'Latency p99 (ms)': report.http.latencyMs.p99,
    'Non-2xx responses': report.http.non2xx,
    'Events accepted/s': report.ingestion.eventsAcceptedPerSecond,
    'Events persisted/s': report.ingestion.eventsPersistedPerSecond,
    'Queue drain after load (s)': (report.ingestion.drainAfterLoadMs / 1000).toFixed(1),
    'All accepted events persisted': report.ingestion.complete,
  });

  if (values.out) {
    mkdirSync(dirname(values.out), { recursive: true });
    writeFileSync(values.out, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Report written to ${values.out}`);
  }
  if (!report.ingestion.complete || report.http.errors > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
