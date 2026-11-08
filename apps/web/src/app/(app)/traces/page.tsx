'use client';

import type { TraceStatus } from '@tracemind/shared';
import { AlertTriangle, MessageSquareText, SearchX } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { AnalyticsShell, type AnalyticsContext } from '@/components/analytics/analytics-shell';
import { StatusBadge } from '@/components/explorer/primitives';
import { traceHref } from '@/components/explorer/project-scope';
import { SearchInput, Segmented } from '@/components/explorer/search-input';
import { Button } from '@/components/ui/button';
import { Badge, Card } from '@/components/ui/card';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { useTraces } from '@/hooks/explorer';
import { formatMs, formatNumber, formatShortDateTime, formatUsd } from '@/lib/format';
import { cn } from '@/lib/utils';

const DURATIONS = [
  { value: undefined, label: 'Any' },
  { value: '2000', label: '> 2s' },
  { value: '5000', label: '> 5s' },
  { value: '10000', label: '> 10s' },
];

function Traces({ project, query, update }: AnalyticsContext) {
  const params = useSearchParams();
  const router = useRouter();
  const q = params.get('q') ?? '';
  const status = (params.get('status') as TraceStatus | null) ?? undefined;
  const minDurationMs = params.get('minDuration') ?? undefined;
  const traces = useTraces(project.id, query, { q: q || undefined, status, minDurationMs });
  const items = traces.data?.pages.flatMap((page) => page.items) ?? [];
  const filtered = Boolean(q || status || minDurationMs);

  const numCell = 'whitespace-nowrap px-3 py-2.5 text-right font-mono text-xs tabular-nums';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput
          label="Search traces"
          placeholder="Search prompts, responses, names or a trace id…"
          value={q}
          onChange={(value) => update({ q: value })}
        />
        <Segmented<TraceStatus>
          label="Status"
          value={status}
          onChange={(value) => update({ status: value })}
          options={[
            { value: undefined, label: 'All' },
            { value: 'success', label: 'Success' },
            { value: 'error', label: 'Errors' },
            { value: 'running', label: 'Running' },
          ]}
        />
        <Segmented<string>
          label="Minimum duration"
          value={minDurationMs}
          onChange={(value) => update({ minDuration: value })}
          options={DURATIONS}
        />
      </div>

      <Card className="min-w-0">
        {traces.isPending ? (
          <LoadingState />
        ) : traces.isError ? (
          <ErrorState error={traces.error} onRetry={() => traces.refetch()} />
        ) : items.length === 0 ? (
          filtered ? (
            <EmptyState
              icon={SearchX}
              title="No traces match"
              description="Try another search term, a wider date range or fewer filters."
              action={
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() =>
                    update({ q: undefined, status: undefined, minDuration: undefined })
                  }
                >
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={MessageSquareText}
              title="No traces in this range"
              description="Pick a wider date range, or send telemetry from your application."
            />
          )
        ) : (
          <div
            className={cn('overflow-x-auto', traces.isPlaceholderData && 'opacity-60')}
            aria-busy={traces.isFetching}
          >
            <table className="w-full min-w-[860px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted">
                  <th className="py-2.5 pl-5 pr-3 font-medium">Trace</th>
                  <th className="px-3 py-2.5 font-medium">Status</th>
                  <th className="px-3 py-2.5 font-medium">Models</th>
                  <th className="px-3 py-2.5 text-right font-medium">Started</th>
                  <th className="px-3 py-2.5 text-right font-medium">Duration</th>
                  <th className="px-3 py-2.5 text-right font-medium">LLM calls</th>
                  <th className="px-3 py-2.5 text-right font-medium">Tokens</th>
                  <th className="px-3 py-2.5 text-right font-medium">Cost</th>
                  <th className="py-2.5 pl-3 pr-5 text-right font-medium">Scores</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {items.map((trace) => {
                  const href = traceHref(project.id, trace.id);
                  return (
                    <tr
                      key={trace.id}
                      className="cursor-pointer hover:bg-surface-raised/50"
                      onClick={(event) => {
                        if ((event.target as HTMLElement).closest('a')) return;
                        router.push(href);
                      }}
                    >
                      <td className="max-w-72 py-2.5 pl-5 pr-3">
                        <Link href={href} className="block truncate font-medium hover:text-primary">
                          {trace.name}
                        </Link>
                        <span className="block truncate font-mono text-[11px] text-subtle">
                          {trace.id}
                          {trace.endUserId ? ` · ${trace.endUserId}` : ''}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5">
                        <span className="flex items-center gap-2">
                          <StatusBadge status={trace.status} />
                          {trace.errorCount > 0 ? (
                            <span
                              className="inline-flex items-center gap-0.5 font-mono text-[11px] text-danger"
                              title={`${trace.errorCount} errors`}
                            >
                              <AlertTriangle className="size-3" aria-hidden />
                              {trace.errorCount}
                            </span>
                          ) : null}
                        </span>
                      </td>
                      <td className="max-w-56 px-3 py-2.5">
                        <span className="block truncate font-mono text-[11px] text-muted">
                          {trace.models.join(', ') || '—'}
                        </span>
                      </td>
                      <td className={numCell}>{formatShortDateTime(trace.startedAt)}</td>
                      <td className={numCell}>{formatMs(trace.durationMs)}</td>
                      <td className={numCell}>{formatNumber(trace.llmCalls)}</td>
                      <td className={numCell}>{formatNumber(trace.totalTokens)}</td>
                      <td className={numCell}>{formatUsd(trace.costUsd)}</td>
                      <td className={cn(numCell, 'pr-5')}>
                        {trace.evaluationCount > 0 ? (
                          <Badge tone="primary">{trace.evaluationCount}</Badge>
                        ) : (
                          <span className="text-subtle">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {traces.hasNextPage ? (
          <div className="border-t border-border px-5 py-3 text-center">
            <Button
              variant="secondary"
              size="sm"
              loading={traces.isFetchingNextPage}
              onClick={() => traces.fetchNextPage()}
            >
              Load more
            </Button>
          </div>
        ) : null}
      </Card>
    </div>
  );
}

export default function TracesPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <AnalyticsShell
        title="Traces"
        description="Every request end to end: search, filter and open a trace to see its spans."
      >
        {(context) => <Traces {...context} />}
      </AnalyticsShell>
    </Suspense>
  );
}
