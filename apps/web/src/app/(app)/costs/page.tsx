'use client';

import { AlertTriangle } from 'lucide-react';
import { Suspense } from 'react';
import { AnalyticsShell, type AnalyticsContext } from '@/components/analytics/analytics-shell';
import { ChartCard, seriesColorMap } from '@/components/analytics/chart-kit';
import { CostByModelChart, CostOverTimeChart } from '@/components/analytics/charts';
import { Kpi, KpiGrid } from '@/components/analytics/kpi';
import { ModelsTable, PricingTable, TopRequestsTable } from '@/components/analytics/tables';
import { LoadingState } from '@/components/ui/states';
import { useBreakdown, useCosts, useOverview, usePricing } from '@/hooks/analytics';
import { formatNumber, formatUsd } from '@/lib/format';

function Costs({ project, query, dimensions }: AnalyticsContext) {
  const costs = useCosts(project.id, query);
  const overview = useOverview(project.id, query);
  const breakdown = useBreakdown(project.id, query, 'model');
  const pricing = usePricing();
  const models = dimensions.models.map((entry) => entry.model);
  const colorFor = seriesColorMap(models);
  const data = costs.data;
  const previous = overview.data?.previous;
  const loading = costs.isPending;
  const requests = overview.data?.current.requests ?? 0;

  return (
    <div className="space-y-6">
      {data && data.unpricedRequests > 0 ? (
        <div
          role="status"
          className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-warning"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <p>
            {formatNumber(data.unpricedRequests)} requests use models without a price in the
            registry and are not included in the estimate. Add them to{' '}
            <code className="font-mono">apps/api/pricing/models.json</code> and run{' '}
            <code className="font-mono">pricing:sync</code>; past costs are recomputed.
          </p>
        </div>
      ) : null}

      <KpiGrid>
        <Kpi
          label="Estimated cost"
          value={data ? formatUsd(data.estimatedCostUsd) : '—'}
          current={data ? Number(data.estimatedCostUsd) : undefined}
          previous={previous ? Number(previous.estimatedCostUsd) : undefined}
          better="down"
          hint="List prices from the registry, valid at the time of each call."
          loading={loading}
        />
        <Kpi
          label="Provider-reported"
          value={data ? formatUsd(data.reportedCostUsd) : '—'}
          hint="Costs your application reported (usage.costUsd). Never overwritten by estimates."
          loading={loading}
        />
        <Kpi
          label="Input tokens cost"
          value={data ? formatUsd(data.inputCostUsd) : '—'}
          loading={loading}
        />
        <Kpi
          label="Output tokens cost"
          value={data ? formatUsd(data.outputCostUsd) : '—'}
          loading={loading}
        />
        <Kpi
          label="Prompt-cache savings"
          value={data ? formatUsd(data.cacheSavingsUsd) : '—'}
          hint="What cached input tokens would have cost at the regular input price, minus what they cost."
          loading={loading}
        />
        <Kpi
          label="Avg cost / request"
          value={data && requests ? formatUsd(Number(data.estimatedCostUsd) / requests) : '—'}
          loading={loading || overview.isPending}
        />
      </KpiGrid>

      <ChartCard
        title="Spend over time"
        description="Estimated cost per interval, stacked by model."
        loading={loading}
        error={costs.error}
        onRetry={() => costs.refetch()}
        empty={data?.series.length === 0}
      >
        {data ? (
          <CostOverTimeChart
            series={data.series}
            bucket={data.bucket}
            colorFor={colorFor}
            models={models}
          />
        ) : null}
      </ChartCard>

      <div className="grid gap-6 xl:grid-cols-5">
        <ChartCard
          className="xl:col-span-2"
          title="Cost by model"
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
          title="Most expensive requests"
          loading={loading}
          error={costs.error}
          onRetry={() => costs.refetch()}
          empty={data?.topRequests.length === 0}
          height={200}
        >
          {data ? (
            <div className="-mx-3 -mb-3">
              <TopRequestsTable rows={data.topRequests} />
            </div>
          ) : null}
        </ChartCard>
      </div>

      <ChartCard
        title="Cost per model"
        loading={breakdown.isPending}
        error={breakdown.error}
        empty={breakdown.data?.length === 0}
        height={160}
      >
        {breakdown.data ? (
          <div className="-mx-3 -mb-3">
            <ModelsTable rows={breakdown.data} colorFor={colorFor} />
          </div>
        ) : null}
      </ChartCard>

      <ChartCard
        title="Price registry"
        description="USD per 1M tokens. Maintained as data (apps/api/pricing/models.json) with the source of every price."
        loading={pricing.isPending}
        error={pricing.error}
        onRetry={() => pricing.refetch()}
        empty={pricing.data?.length === 0}
        height={160}
      >
        {pricing.data ? (
          <div className="-mx-3 -mb-3">
            <PricingTable rows={pricing.data} />
          </div>
        ) : null}
      </ChartCard>
    </div>
  );
}

export default function CostsPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <AnalyticsShell
        title="Costs"
        description="What your LLM usage costs, and where the money goes."
      >
        {(context) => <Costs {...context} />}
      </AnalyticsShell>
    </Suspense>
  );
}
