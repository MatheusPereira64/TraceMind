'use client';

import { Suspense } from 'react';
import { AnalyticsShell, type AnalyticsContext } from '@/components/analytics/analytics-shell';
import { ChartCard, seriesColorMap } from '@/components/analytics/chart-kit';
import { CostByModelChart, RequestsChart, TokensChart } from '@/components/analytics/charts';
import { Kpi, KpiGrid } from '@/components/analytics/kpi';
import { ModelsTable } from '@/components/analytics/tables';
import { GettingStarted } from '@/components/getting-started';
import { LoadingState } from '@/components/ui/states';
import { useBreakdown, useOverview, useTimeseries } from '@/hooks/analytics';
import { formatMs, formatNumber, formatPercent, formatUsd } from '@/lib/format';

function Dashboard({ project, query, dimensions }: AnalyticsContext) {
  const overview = useOverview(project.id, query);
  const timeseries = useTimeseries(project.id, query);
  const breakdown = useBreakdown(project.id, query, 'model');
  const colorFor = seriesColorMap(dimensions.models.map((entry) => entry.model));
  const current = overview.data?.current;
  const previous = overview.data?.previous;
  const loading = overview.isPending;

  return (
    <div className="space-y-6">
      <KpiGrid>
        <Kpi
          label="LLM requests"
          value={current ? formatNumber(current.requests) : '—'}
          current={current?.requests}
          previous={previous?.requests}
          loading={loading}
        />
        <Kpi
          label="Tokens"
          value={current ? formatNumber(current.totalTokens) : '—'}
          current={current?.totalTokens}
          previous={previous?.totalTokens}
          loading={loading}
        />
        <Kpi
          label="Estimated cost"
          value={current ? formatUsd(current.estimatedCostUsd) : '—'}
          current={current ? Number(current.estimatedCostUsd) : undefined}
          previous={previous ? Number(previous.estimatedCostUsd) : undefined}
          better="down"
          hint="Computed from the model price registry at the time of each call. Provider-reported costs are tracked separately on the Costs page."
          loading={loading}
        />
        <Kpi
          label="Avg latency"
          value={formatMs(current?.avgLatencyMs)}
          current={current?.avgLatencyMs ?? undefined}
          previous={previous?.avgLatencyMs ?? undefined}
          better="down"
          loading={loading}
        />
        <Kpi
          label="p95 latency"
          value={formatMs(current?.p95LatencyMs)}
          current={current?.p95LatencyMs ?? undefined}
          previous={previous?.p95LatencyMs ?? undefined}
          better="down"
          hint={`Exact percentile over every LLM call in the range. p50: ${formatMs(current?.p50LatencyMs)}.`}
          loading={loading}
        />
        <Kpi
          label="Success rate"
          value={current ? (current.requests ? formatPercent(1 - current.errorRate) : '—') : '—'}
          current={current ? 1 - current.errorRate : undefined}
          previous={previous && previous.requests ? 1 - previous.errorRate : undefined}
          better="up"
          loading={loading}
        />
      </KpiGrid>

      <div className="grid gap-6 xl:grid-cols-2">
        <ChartCard
          title="Requests over time"
          description="LLM calls per interval, split by outcome."
          loading={timeseries.isPending}
          error={timeseries.error}
          onRetry={() => timeseries.refetch()}
          empty={timeseries.data?.points.every((point) => point.requests === 0)}
        >
          {timeseries.data ? <RequestsChart data={timeseries.data} /> : null}
        </ChartCard>
        <ChartCard
          title="Token consumption"
          description="Input and output tokens per interval."
          loading={timeseries.isPending}
          error={timeseries.error}
          onRetry={() => timeseries.refetch()}
          empty={timeseries.data?.points.every(
            (point) => point.inputTokens + point.outputTokens === 0,
          )}
        >
          {timeseries.data ? <TokensChart data={timeseries.data} /> : null}
        </ChartCard>
      </div>

      <div className="grid gap-6 xl:grid-cols-5">
        <ChartCard
          className="xl:col-span-2"
          title="Cost by model"
          description="Estimated spend in the selected range."
          loading={breakdown.isPending}
          error={breakdown.error}
          onRetry={() => breakdown.refetch()}
          empty={breakdown.data?.every((row) => Number(row.costUsd) === 0)}
          height={200}
        >
          {breakdown.data ? <CostByModelChart rows={breakdown.data} colorFor={colorFor} /> : null}
        </ChartCard>
        <ChartCard
          className="xl:col-span-3"
          title="Models"
          description="Usage, reliability, latency and cost per model."
          loading={breakdown.isPending}
          error={breakdown.error}
          onRetry={() => breakdown.refetch()}
          empty={breakdown.data?.length === 0}
          height={200}
        >
          {breakdown.data ? (
            <div className="-mx-3 -mb-3">
              <ModelsTable rows={breakdown.data} colorFor={colorFor} />
            </div>
          ) : null}
        </ChartCard>
      </div>
    </div>
  );
}

export default function OverviewPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <AnalyticsShell
        title="Overview"
        description="Health, usage and spend of your LLM applications."
        onboarding={<GettingStarted />}
      >
        {(context) => <Dashboard {...context} />}
      </AnalyticsShell>
    </Suspense>
  );
}
