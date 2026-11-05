'use client';

import { Activity, AlertTriangle } from 'lucide-react';
import { useState } from 'react';
import { useIngestionStatus } from '@/hooks/queries';
import { PUBLIC_API_URL } from '@/lib/config';
import { cn, formatRelative } from '@/lib/utils';
import { Badge, Card, CardHeader } from './ui/card';
import { CopyButton } from './ui/copy-button';
import { ErrorState, LoadingState } from './ui/states';

const numberFormat = new Intl.NumberFormat('en');

export const SDK_SNIPPET = `import { TraceMind, observeOpenAI } from '@tracemind/sdk';
import OpenAI from 'openai';

const tracemind = new TraceMind({
  apiKey: process.env.TRACEMIND_API_KEY,
  baseUrl: '${PUBLIC_API_URL}',
});

// Every chat completion becomes a trace with tokens, cost and latency.
const openai = observeOpenAI(new OpenAI(), { tracemind });

await openai.chat.completions.create({
  model: 'gpt-4.1',
  messages: [{ role: 'user', content: 'Hello!' }],
});

await tracemind.shutdown(); // flush before the process exits`;

const OTLP_SNIPPET = `# OpenTelemetry Collector → TraceMind
exporters:
  otlphttp/tracemind:
    traces_endpoint: ${PUBLIC_API_URL}/v1/ingest/otlp/v1/traces
    encoding: json
    headers:
      Authorization: Bearer \${env:TRACEMIND_API_KEY}`;

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-1 font-mono text-lg tabular-nums">{value}</dd>
    </div>
  );
}

export function IngestionPanel({ projectId }: { projectId: string }) {
  const status = useIngestionStatus(projectId);
  const [tab, setTab] = useState<'sdk' | 'otlp'>('sdk');
  const snippet = tab === 'sdk' ? SDK_SNIPPET : OTLP_SNIPPET;

  return (
    <Card>
      <CardHeader
        title="Telemetry"
        description="Live view of what this project has received. Updates every few seconds."
        action={
          status.data && status.data.traceCount > 0 ? (
            <Badge tone="success">
              <Activity className="mr-1 size-3" aria-hidden /> receiving
            </Badge>
          ) : (
            <Badge>waiting for first trace</Badge>
          )
        }
      />
      {status.isPending ? (
        <LoadingState />
      ) : status.isError ? (
        <ErrorState error={status.error} onRetry={() => status.refetch()} />
      ) : (
        <>
          <dl className="grid grid-cols-3 gap-5 px-5 py-4">
            <Stat label="Traces" value={numberFormat.format(status.data.traceCount)} />
            <Stat label="Spans" value={numberFormat.format(status.data.spanCount)} />
            <Stat
              label="Last received"
              value={status.data.lastReceivedAt ? formatRelative(status.data.lastReceivedAt) : '—'}
            />
          </dl>

          {status.data.recentFailures.length > 0 ? (
            <div className="border-t border-border px-5 py-4">
              <h3 className="mb-2 flex items-center gap-1.5 text-sm font-medium text-warning">
                <AlertTriangle className="size-4" aria-hidden /> Recently rejected or failed
              </h3>
              <ul className="space-y-1.5">
                {status.data.recentFailures.map((failure) => (
                  <li key={failure.id} className="flex gap-3 text-xs">
                    <span className="shrink-0 text-subtle">
                      {formatRelative(failure.createdAt)}
                    </span>
                    <span className="break-all font-mono text-muted">{failure.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="border-t border-border px-5 py-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div
                role="tablist"
                aria-label="Integration"
                className="flex gap-1 rounded-md border border-border p-0.5"
              >
                {(['sdk', 'otlp'] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    role="tab"
                    aria-selected={tab === value}
                    onClick={() => setTab(value)}
                    className={cn(
                      'rounded px-2.5 py-1 text-xs font-medium transition-colors',
                      tab === value
                        ? 'bg-surface-raised text-foreground'
                        : 'text-muted hover:text-foreground',
                    )}
                  >
                    {value === 'sdk' ? 'TypeScript SDK' : 'OpenTelemetry'}
                  </button>
                ))}
              </div>
              <CopyButton value={snippet} />
            </div>
            <pre className="overflow-x-auto rounded-md border border-border bg-background p-3 font-mono text-xs leading-relaxed text-muted">
              {snippet}
            </pre>
          </div>
        </>
      )}
    </Card>
  );
}
