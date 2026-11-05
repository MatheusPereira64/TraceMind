'use client';

import { Suspense } from 'react';
import { AnalyticsShell, type AnalyticsContext } from '@/components/analytics/analytics-shell';
import { ChartCard } from '@/components/analytics/chart-kit';
import { LatencyChart, LatencyHistogram } from '@/components/analytics/charts';
import { Kpi, KpiGrid } from '@/components/analytics/kpi';
import { SlowestTable } from '@/components/analytics/tables';
import { LoadingState } from '@/components/ui/states';
import { useOverview, usePerformance, useTimeseries } from '@/hooks/analytics';
import { formatMs, formatNumber, formatPercent } from '@/lib/format';

function Performance({ project, query }: AnalyticsContext) {
  const overview = useOverview(project.id, query);
  const timeseries = useTimeseries(project.id, query);
  const performance = usePerformance(project.id, query);
  const current = overview.data?.current;
  const previous = overview.data?.previous;
  const loading = overview.isPending;

  return (
    <div className="space-y-6">
      <KpiGrid>
        <Kpi
          label="p50 latency"
          value={formatMs(current?.p50LatencyMs)}
          current={current?.p50LatencyMs ?? undefined}
          previous={previous?.p50LatencyMs ?? undefined}
          better="down"
          loading={loading}
        />
        <Kpi
          label="p95 latency"
          value={formatMs(current?.p95LatencyMs)}
          current={current?.p95LatencyMs ?? undefined}
          previous={previous?.p95LatencyMs ?? undefined}
          better="down"
          loading={loading}
        />
        <Kpi
          label="p99 latency"
          value={formatMs(current?.p99LatencyMs)}
          current={current?.p99LatencyMs ?? undefined}
          previous={previous?.p99LatencyMs ?? undefined}
          better="down"
          loading={loading}
        />
        <Kpi
          label="Throughput"
          value={
            current
              ? `${current.throughputPerMinute < 10 ? current.throughputPerMinute.toFixed(2) : formatNumber(current.throughputPerMinute)}/min`
              : '—'
          }
          current={current?.throughputPerMinute}
          previous={previous?.throughputPerMinute}
          hint="Average LLM calls per minute over the selected range."
          loading={loading}
        />
        <Kpi
          label="Error rate"
          value={current ? formatPercent(current.errorRate) : '—'}
          current={current?.errorRate}
          previous={previous?.errorRate}
          better="down"
          loading={loading}
        />
        <Kpi
          label="Timeouts"
          value={current ? formatNumber(current.timeouts) : '—'}
          current={current?.timeouts}
          previous={previous?.timeouts}
          better="down"
          loading={loading}
        />
      </KpiGrid>

      <ChartCard
        title="Latency percentiles"
        description="p50, p95 and p99 of LLM call duration, computed exactly per interval."
        loading={timeseries.isPending}
        error={timeseries.error}
        onRetry={() => timeseries.refetch()}
        empty={timeseries.data?.points.every((point) => point.p50LatencyMs === null)}
      >
        {timeseries.data ? <LatencyChart data={timeseries.data} /> : null}
      </ChartCard>

      <div className="grid gap-6 xl:grid-cols-5">
        <ChartCard
          className="xl:col-span-2"
          title="Latency distribution"
          description="How many calls finished within each duration band."
          loading={performance.isPending}
          error={performance.error}
          onRetry={() => performance.refetch()}
          empty={performance.data?.histogram.every((bin) => bin.requests === 0)}
        >
          {performance.data ? <LatencyHistogram data={performance.data.histogram} /> : null}
        </ChartCard>
        <ChartCard
          className="xl:col-span-3"
          title="Slowest requests"
          description="Start here when investigating latency regressions."
          loading={performance.isPending}
          error={performance.error}
          onRetry={() => performance.refetch()}
          empty={performance.data?.slowest.length === 0}
        >
          {performance.data ? (
            <div className="-mx-3 -mb-3">
              <SlowestTable rows={performance.data.slowest} />
            </div>
          ) : null}
        </ChartCard>
      </div>
    </div>
  );
}

export default function AnalyticsPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <AnalyticsShell
        title="Analytics"
        description="Latency, throughput and reliability of LLM calls."
      >
        {(context) => <Performance {...context} />}
      </AnalyticsShell>
    </Suspense>
  );
}
