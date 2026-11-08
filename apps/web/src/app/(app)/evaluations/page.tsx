'use client';

import { hasRoleAtLeast, type EvaluationSource } from '@tracemind/shared';
import { ClipboardCheck } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { AnalyticsShell, type AnalyticsContext } from '@/components/analytics/analytics-shell';
import { ChartCard } from '@/components/analytics/chart-kit';
import { Kpi, KpiGrid } from '@/components/analytics/kpi';
import { CriteriaManager } from '@/components/explorer/criteria-manager';
import { EvaluationValue } from '@/components/explorer/evaluations';
import { traceHref } from '@/components/explorer/project-scope';
import { formatAverage, LabelBars, QualityTrendChart } from '@/components/explorer/quality-charts';
import { Segmented } from '@/components/explorer/search-input';
import { useOrganization } from '@/components/organization-context';
import { Button } from '@/components/ui/button';
import { Badge, Card, CardHeader } from '@/components/ui/card';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { useCriteria, useEvaluationSummary, useEvaluations } from '@/hooks/explorer';
import { formatNumber, formatPercent, formatShortDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';

function RecentEvaluations({ project, query, update }: AnalyticsContext) {
  const params = useSearchParams();
  const criterion = params.get('criterion') ?? undefined;
  const source = (params.get('source') as EvaluationSource | null) ?? undefined;
  const evaluations = useEvaluations(project.id, query, { criterion, source });
  const items = evaluations.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <Card className="min-w-0">
      <CardHeader
        title="Recent evaluations"
        description={criterion ? `Criterion: ${criterion}` : 'All criteria, newest first.'}
        action={
          <div className="flex items-center gap-2">
            {criterion ? (
              <Button variant="ghost" size="sm" onClick={() => update({ criterion: undefined })}>
                All criteria
              </Button>
            ) : null}
            <Segmented<EvaluationSource>
              label="Source"
              value={source}
              onChange={(value) => update({ source: value })}
              options={[
                { value: undefined, label: 'All' },
                { value: 'human', label: 'Reviewers' },
                { value: 'api', label: 'SDK' },
                { value: 'llm_judge', label: 'LLM judge' },
              ]}
            />
          </div>
        }
      />
      {evaluations.isPending ? (
        <LoadingState />
      ) : evaluations.isError ? (
        <ErrorState error={evaluations.error} onRetry={() => evaluations.refetch()} />
      ) : items.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-muted">No evaluations match.</p>
      ) : (
        <div className="overflow-x-auto">
          <table
            className={cn(
              'w-full min-w-[720px] text-sm',
              evaluations.isPlaceholderData && 'opacity-60',
            )}
          >
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted">
                <th className="py-2.5 pl-5 pr-3 font-medium">Trace</th>
                <th className="px-3 py-2.5 font-medium">Criterion</th>
                <th className="px-3 py-2.5 font-medium">Value</th>
                <th className="px-3 py-2.5 font-medium">Comment</th>
                <th className="px-3 py-2.5 font-medium">Source</th>
                <th className="py-2.5 pl-3 pr-5 text-right font-medium">Recorded</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {items.map((evaluation) => (
                <tr key={evaluation.id}>
                  <td className="max-w-56 py-2.5 pl-5 pr-3">
                    <Link
                      href={traceHref(
                        project.id,
                        evaluation.traceId,
                        evaluation.spanId ?? undefined,
                      )}
                      className="block truncate hover:text-primary"
                    >
                      {evaluation.traceName}
                    </Link>
                    <span className="block truncate font-mono text-[11px] text-subtle">
                      {evaluation.traceId}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5">{evaluation.criterion}</td>
                  <td className="whitespace-nowrap px-3 py-2.5">
                    <EvaluationValue evaluation={evaluation} />
                  </td>
                  <td className="max-w-64 px-3 py-2.5">
                    <span
                      className="block truncate text-muted"
                      title={evaluation.comment ?? undefined}
                    >
                      {evaluation.comment ?? '—'}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5">
                    <Badge tone={evaluation.source === 'human' ? 'primary' : 'neutral'}>
                      {evaluation.source}
                    </Badge>
                    {evaluation.createdBy ? (
                      <span className="ml-1.5 text-xs text-muted">{evaluation.createdBy.name}</span>
                    ) : null}
                  </td>
                  <td className="whitespace-nowrap py-2.5 pl-3 pr-5 text-right font-mono text-xs tabular-nums">
                    {formatShortDateTime(evaluation.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {evaluations.hasNextPage ? (
        <div className="border-t border-border px-5 py-3 text-center">
          <Button
            variant="secondary"
            size="sm"
            loading={evaluations.isFetchingNextPage}
            onClick={() => evaluations.fetchNextPage()}
          >
            Load more
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

function Evaluations(context: AnalyticsContext) {
  const { project, query, update } = context;
  const { current } = useOrganization();
  const summary = useEvaluationSummary(project.id, query);
  const criteria = useCriteria(project.id);
  const data = summary.data;
  const scored = data?.criteria.filter((entry) => entry.count > 0) ?? [];
  const thumbs = scored.filter((entry) => entry.kind === 'thumbs');
  const up = thumbs.reduce((sum, entry) => sum + entry.positive, 0);
  const votes = thumbs.reduce((sum, entry) => sum + entry.positive + entry.negative, 0);
  const human = data?.bySource.find((entry) => entry.source === 'human')?.count ?? 0;
  const counts = new Map(data?.criteria.map((entry) => [entry.criterion, entry.count]));

  if (summary.isError)
    return <ErrorState error={summary.error} onRetry={() => summary.refetch()} />;

  return (
    <div className="space-y-6">
      <KpiGrid>
        <Kpi
          label="Evaluations"
          value={data ? formatNumber(data.total) : '—'}
          loading={summary.isPending}
        />
        <Kpi
          label="Traces evaluated"
          value={data ? formatPercent(data.coverage) : '—'}
          hint="Share of traces started in the range with at least one evaluation."
          loading={summary.isPending}
        />
        <Kpi
          label="Positive feedback"
          value={votes ? formatPercent(up / votes) : '—'}
          hint="Thumbs up out of all thumbs votes, across thumbs criteria."
          loading={summary.isPending}
        />
        <Kpi label="Thumbs votes" value={formatNumber(votes)} loading={summary.isPending} />
        <Kpi label="Reviewer scores" value={formatNumber(human)} loading={summary.isPending} />
        <Kpi
          label="Criteria in use"
          value={formatNumber(scored.length)}
          loading={summary.isPending}
        />
      </KpiGrid>

      {data && scored.length === 0 ? (
        <Card>
          <EmptyState
            icon={ClipboardCheck}
            title="No evaluations in this range"
            description="Score traces from the trace view, send scores with the SDK (span.score(…)) or collect thumbs feedback from your users."
          />
        </Card>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2 xl:grid-cols-3">
          {(summary.isPending ? [] : scored).map((entry) => (
            <ChartCard
              key={entry.criterion}
              title={entry.criterion}
              description={
                entry.kind === 'categorical'
                  ? `${formatNumber(entry.count)} labels`
                  : `${entry.kind === 'thumbs' ? 'Positive rate' : 'Average score'} ${formatAverage(entry, entry.average)} · ${formatNumber(entry.count)} evaluations`
              }
              action={
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => update({ criterion: entry.criterion })}
                >
                  List
                </Button>
              }
              height={180}
            >
              {entry.kind === 'categorical' ? (
                <LabelBars summary={entry} />
              ) : (
                <QualityTrendChart summary={entry} bucket={data!.bucket} />
              )}
            </ChartCard>
          ))}
          {summary.isPending
            ? [0, 1, 2].map((index) => (
                <ChartCard key={index} title="Loading…" loading height={180}>
                  {null}
                </ChartCard>
              ))
            : null}
        </div>
      )}

      <div className="space-y-6">
        <Card className="min-w-0">
          <CardHeader
            title="Criteria"
            description="What each score means. Admins can add and edit criteria."
          />
          {criteria.isPending ? (
            <LoadingState />
          ) : criteria.isError ? (
            <ErrorState error={criteria.error} onRetry={() => criteria.refetch()} />
          ) : (
            <CriteriaManager
              projectId={project.id}
              criteria={criteria.data}
              counts={counts}
              canManage={hasRoleAtLeast(current.role, 'admin')}
            />
          )}
        </Card>
        <RecentEvaluations {...context} />
      </div>
    </div>
  );
}

export default function EvaluationsPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <AnalyticsShell
        title="Evaluations"
        description="Response quality over time: user feedback, review scores and custom criteria."
      >
        {(context) => <Evaluations {...context} />}
      </AnalyticsShell>
    </Suspense>
  );
}
