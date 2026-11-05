'use client';

import { ERROR_TYPES, type ErrorType } from '@tracemind/shared';
import { Suspense, useState } from 'react';
import { AnalyticsShell, type AnalyticsContext } from '@/components/analytics/analytics-shell';
import { ChartCard } from '@/components/analytics/chart-kit';
import {
  ERROR_TYPE_LABEL,
  ErrorsOverTimeChart,
  errorTypeColor,
} from '@/components/analytics/charts';
import { Kpi, KpiGrid } from '@/components/analytics/kpi';
import { ErrorsTable } from '@/components/analytics/tables';
import { Button } from '@/components/ui/button';
import { LoadingState } from '@/components/ui/states';
import { useErrors, useOverview, useTimeseries } from '@/hooks/analytics';
import { formatNumber, formatPercent } from '@/lib/format';
import { cn } from '@/lib/utils';

function Errors({ project, query }: AnalyticsContext) {
  const [type, setType] = useState<ErrorType | undefined>(undefined);
  const overview = useOverview(project.id, query);
  const timeseries = useTimeseries(project.id, query);
  const errors = useErrors(project.id, query, type);
  const first = errors.data?.pages[0];
  const items = errors.data?.pages.flatMap((page) => page.items) ?? [];
  const counts = new Map(first?.byType.map((entry) => [entry.type, entry.count]));
  const total = first?.byType.reduce((sum, entry) => sum + entry.count, 0) ?? 0;
  const current = overview.data?.current;
  const previous = overview.data?.previous;

  return (
    <div className="space-y-6">
      <KpiGrid>
        <Kpi label="Errors" value={first ? formatNumber(total) : '—'} loading={errors.isPending} />
        <Kpi
          label="LLM error rate"
          value={current ? formatPercent(current.errorRate) : '—'}
          current={current?.errorRate}
          previous={previous?.errorRate}
          better="down"
          loading={overview.isPending}
        />
        <Kpi
          label="Rate limits"
          value={formatNumber(counts.get('rate_limit') ?? 0)}
          current={current?.rateLimits}
          previous={previous?.rateLimits}
          better="down"
          loading={errors.isPending}
        />
        <Kpi
          label="Timeouts"
          value={formatNumber(counts.get('timeout') ?? 0)}
          current={current?.timeouts}
          previous={previous?.timeouts}
          better="down"
          loading={errors.isPending}
        />
        <Kpi
          label="Provider errors"
          value={formatNumber(counts.get('provider_error') ?? 0)}
          loading={errors.isPending}
        />
        <Kpi
          label="Tool call failures"
          value={formatNumber(counts.get('tool_call_failed') ?? 0)}
          loading={errors.isPending}
        />
      </KpiGrid>

      <ChartCard
        title="Errors over time"
        description="By error type. Spikes usually point at a provider incident or a bad deploy."
        loading={errors.isPending || timeseries.isPending}
        error={errors.error}
        onRetry={() => errors.refetch()}
        empty={first?.series.length === 0}
      >
        {first && timeseries.data ? (
          <ErrorsOverTimeChart
            series={first.series}
            points={timeseries.data.points.map((point) => point.t)}
            bucket={first.bucket}
          />
        ) : null}
      </ChartCard>

      <ChartCard
        title="Recent errors"
        description="Newest first. Each error keeps its trace id for investigation."
        action={
          <div
            className="flex flex-wrap justify-end gap-1"
            role="radiogroup"
            aria-label="Error type"
          >
            {[undefined, ...ERROR_TYPES.filter((candidate) => counts.has(candidate))].map(
              (candidate) => (
                <button
                  key={candidate ?? 'all'}
                  type="button"
                  role="radio"
                  aria-checked={type === candidate}
                  onClick={() => setType(candidate)}
                  className={cn(
                    'inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs transition-colors',
                    type === candidate
                      ? 'border-border-strong bg-surface-raised text-foreground'
                      : 'border-transparent text-muted hover:text-foreground',
                  )}
                >
                  {candidate ? (
                    <span
                      aria-hidden
                      className="size-2 rounded-sm"
                      style={{ background: errorTypeColor(candidate) }}
                    />
                  ) : null}
                  {candidate ? ERROR_TYPE_LABEL[candidate] : 'All'}
                  {candidate ? <span className="text-subtle">{counts.get(candidate)}</span> : null}
                </button>
              ),
            )}
          </div>
        }
        loading={errors.isPending}
        error={errors.error}
        onRetry={() => errors.refetch()}
        empty={items.length === 0}
        height={200}
      >
        <div className="-mx-3 -mb-3">
          <ErrorsTable rows={items} />
          {errors.hasNextPage ? (
            <div className="border-t border-border px-5 py-3 text-center">
              <Button
                variant="secondary"
                size="sm"
                loading={errors.isFetchingNextPage}
                onClick={() => errors.fetchNextPage()}
              >
                Load more
              </Button>
            </div>
          ) : null}
        </div>
      </ChartCard>
    </div>
  );
}

export default function ErrorsPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <AnalyticsShell
        title="Errors"
        description="Provider failures, rate limits, timeouts and failed tool calls."
      >
        {(context) => <Errors {...context} />}
      </AnalyticsShell>
    </Suspense>
  );
}
