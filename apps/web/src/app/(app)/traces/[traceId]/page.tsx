'use client';

import {
  hasRoleAtLeast,
  type ProjectDto,
  type SpanDto,
  type TraceDetailDto,
} from '@tracemind/shared';
import { AlertTriangle, ArrowLeft, Search } from 'lucide-react';
import Link from 'next/link';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { PageHeader } from '@/components/app-shell';
import { ERROR_TYPE_LABEL } from '@/components/analytics/charts';
import { EvaluationList, QuickFeedback, ScoreForm } from '@/components/explorer/evaluations';
import { Facts, KindIcon, PayloadView, StatusBadge, Tabs } from '@/components/explorer/primitives';
import { ProjectScope } from '@/components/explorer/project-scope';
import { Waterfall } from '@/components/explorer/waterfall';
import { useOrganization } from '@/components/organization-context';
import { buttonVariants } from '@/components/ui/button';
import { Badge, Card, CardHeader } from '@/components/ui/card';
import { CopyButton } from '@/components/ui/copy-button';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { useTrace } from '@/hooks/explorer';
import { ApiError } from '@/lib/api-client';
import { formatMs, formatNumber, formatShortDateTime, formatUsd } from '@/lib/format';

type SpanTab = 'input' | 'output' | 'parameters' | 'metadata';

function SpanPanel({
  span,
  project,
  trace,
  canEdit,
}: {
  span: SpanDto;
  project: ProjectDto;
  trace: TraceDetailDto;
  canEdit: boolean;
}) {
  const [tab, setTab] = useState<SpanTab>('input');
  const evaluations = trace.evaluations.filter((evaluation) => evaluation.spanId === span.id);
  const usage = span.usage;

  return (
    <Card className="min-w-0">
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <KindIcon kind={span.kind} />
            <span className="truncate">{span.name}</span>
          </span>
        }
        description={
          <span className="font-mono text-xs">
            {span.kind} · {span.id}
          </span>
        }
        action={<StatusBadge status={span.status} />}
      />
      <div className="space-y-5 px-5 py-4">
        <Facts
          items={[
            ['Duration', span.durationMs === null ? 'running' : formatMs(span.durationMs)],
            ['Started', formatShortDateTime(span.startedAt)],
            ...(span.model
              ? ([
                  ['Model', span.model],
                  ['Provider', span.provider ?? '—'],
                ] as Array<[string, string]>)
              : []),
            ...(usage
              ? ([
                  ['Input tokens', formatNumber(usage.inputTokens)],
                  ['Output tokens', formatNumber(usage.outputTokens)],
                  ['Cached input', formatNumber(usage.cachedInputTokens)],
                  [
                    'Estimated cost',
                    usage.estimatedCostUsd ? formatUsd(usage.estimatedCostUsd) : 'no price',
                  ],
                ] as Array<[string, string]>)
              : []),
            ...(usage?.reportedCostUsd
              ? ([['Reported cost', formatUsd(usage.reportedCostUsd)]] as Array<[string, string]>)
              : []),
          ]}
        />

        {span.errors.length > 0 ? (
          <ul className="space-y-2" aria-label="Errors">
            {span.errors.map((error, index) => (
              <li
                key={index}
                className="flex gap-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm"
              >
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
                <div className="min-w-0">
                  <p className="font-medium text-danger">
                    {ERROR_TYPE_LABEL[error.type]}
                    {error.httpStatus ? ` · HTTP ${error.httpStatus}` : ''}
                    {error.code ? ` · ${error.code}` : ''}
                  </p>
                  <p className="break-words text-foreground">{error.message}</p>
                </div>
              </li>
            ))}
          </ul>
        ) : null}

        <div>
          <Tabs<SpanTab>
            label="Span data"
            value={tab}
            onChange={setTab}
            tabs={[
              { id: 'input', label: span.kind === 'llm' ? 'Prompt' : 'Input' },
              { id: 'output', label: span.kind === 'llm' ? 'Completion' : 'Output' },
              { id: 'parameters', label: 'Model config' },
              { id: 'metadata', label: 'Metadata' },
            ]}
          />
          <div className="pt-3">
            {tab === 'input' ? (
              <PayloadView value={span.input} />
            ) : tab === 'output' ? (
              <PayloadView
                value={span.output}
                empty={span.status === 'error' ? 'No output: the call failed.' : 'Not recorded'}
              />
            ) : tab === 'parameters' ? (
              <PayloadView value={span.modelParameters} empty="No model parameters recorded" />
            ) : (
              <PayloadView value={span.metadata} />
            )}
          </div>
        </div>

        {span.kind === 'llm' ? (
          <div className="space-y-3 border-t border-border pt-4">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold">Response quality</h3>
              {canEdit ? (
                <QuickFeedback
                  projectId={project.id}
                  traceId={trace.trace.id}
                  spanId={span.id}
                  evaluations={trace.evaluations}
                />
              ) : null}
            </div>
            <EvaluationList
              projectId={project.id}
              traceId={trace.trace.id}
              evaluations={evaluations}
              canEdit={canEdit}
            />
          </div>
        ) : null}
      </div>
    </Card>
  );
}

function TraceView({ project, traceId }: { project: ProjectDto; traceId: string }) {
  const { current } = useOrganization();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const trace = useTrace(project.id, traceId);
  const [scoring, setScoring] = useState(false);
  const canEdit = hasRoleAtLeast(current.role, 'member');

  if (trace.isPending) return <LoadingState />;
  if (trace.isError) {
    if (trace.error instanceof ApiError && trace.error.status === 404)
      return (
        <Card>
          <EmptyState
            icon={Search}
            title="Trace not found"
            description={`No trace "${traceId}" in ${project.name}. It may not be ingested yet, or it was removed by the retention policy.`}
            action={
              <Link
                href={`/traces?project=${project.id}`}
                className={buttonVariants({ size: 'sm' })}
              >
                Back to traces
              </Link>
            }
          />
        </Card>
      );
    return <ErrorState error={trace.error} onRetry={() => trace.refetch()} />;
  }

  const data = trace.data;
  const { trace: info, totals } = data;
  const firstLlm = data.spans.find((span) => span.kind === 'llm');
  const selectedId = params.get('span') ?? firstLlm?.id ?? data.spans[0]?.id;
  const selected = data.spans.find((span) => span.id === selectedId);
  const select = (spanId: string) => {
    const next = new URLSearchParams(params.toString());
    next.set('span', spanId);
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  };
  const traceEvaluations = data.evaluations.filter((evaluation) => evaluation.spanId === null);

  return (
    <div className="space-y-6">
      <PageHeader
        title={info.name}
        description={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-mono text-xs">{info.id}</span>
            <StatusBadge status={info.status} />
            <Badge>{info.environment}</Badge>
            {info.isSimulated ? <Badge tone="warning">simulated</Badge> : null}
            {!info.isComplete ? <Badge tone="warning">spans still arriving</Badge> : null}
            {info.tags
              .filter((tag) => !(info.isSimulated && tag === 'simulated'))
              .map((tag) => (
                <Badge key={tag} tone="primary">
                  {tag}
                </Badge>
              ))}
          </span>
        }
        actions={
          <>
            <Link
              href={`/traces?project=${project.id}`}
              className={buttonVariants({ variant: 'ghost', size: 'sm' })}
            >
              <ArrowLeft /> Traces
            </Link>
            <CopyButton value={info.id} label="Copy id" />
          </>
        }
      />

      <Card className="px-5 py-4">
        <Facts
          items={[
            ['Started', formatShortDateTime(info.startedAt)],
            ['Duration', info.durationMs === null ? 'running' : formatMs(info.durationMs)],
            ['Spans', formatNumber(totals.spans)],
            ['LLM calls', formatNumber(totals.llmCalls)],
            ['Tokens', formatNumber(totals.totalTokens)],
            ['Estimated cost', formatUsd(totals.costUsd)],
            ['Errors', formatNumber(totals.errors)],
            ['User', info.endUserId ?? '—'],
            ['Session', info.sessionId ?? '—'],
          ]}
        />
      </Card>

      {data.errors.length > 0 ? (
        <Card className="border-danger/40 px-5 py-3 text-sm">
          {data.errors.map((error, index) => (
            <p key={index} className="text-danger">
              {ERROR_TYPE_LABEL[error.type]}: {error.message}
            </p>
          ))}
        </Card>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,7fr)_minmax(0,6fr)]">
        <Card className="min-w-0 self-start">
          <CardHeader
            title="Timeline"
            description="Spans in execution order; bar length is duration. Select a span to inspect it."
          />
          {data.spans.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-muted">This trace has no spans yet.</p>
          ) : (
            <Waterfall spans={data.spans} trace={info} selectedId={selectedId} onSelect={select} />
          )}
        </Card>
        {selected ? (
          <SpanPanel
            key={selected.uid}
            span={selected}
            project={project}
            trace={data}
            canEdit={canEdit}
          />
        ) : null}
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <Card className="min-w-0">
          <CardHeader title="Trace input & output" description="What the user sent and received." />
          <div className="space-y-4 px-5 py-4">
            <div>
              <h3 className="mb-2 text-xs font-medium text-muted">Input</h3>
              <PayloadView value={info.input} />
            </div>
            <div>
              <h3 className="mb-2 text-xs font-medium text-muted">Output</h3>
              <PayloadView value={info.output} />
            </div>
          </div>
        </Card>
        <Card className="min-w-0 self-start">
          <CardHeader
            title="Evaluations"
            description="Scores for the whole trace, from users, your code or reviewers."
            action={
              canEdit ? (
                <div className="flex items-center gap-2">
                  <QuickFeedback
                    projectId={project.id}
                    traceId={info.id}
                    evaluations={data.evaluations}
                  />
                  <button
                    type="button"
                    className={buttonVariants({ variant: 'secondary', size: 'sm' })}
                    onClick={() => setScoring((value) => !value)}
                    aria-expanded={scoring}
                  >
                    Add score
                  </button>
                </div>
              ) : undefined
            }
          />
          <div className="space-y-4 px-5 py-3">
            {scoring ? (
              <div className="rounded-md border border-border bg-background/40 p-4">
                <ScoreForm
                  projectId={project.id}
                  traceId={info.id}
                  onDone={() => setScoring(false)}
                />
              </div>
            ) : null}
            <EvaluationList
              projectId={project.id}
              traceId={info.id}
              evaluations={traceEvaluations}
              canEdit={canEdit}
            />
          </div>
        </Card>
      </div>
    </div>
  );
}

export default function TracePage() {
  const { traceId } = useParams<{ traceId: string }>();
  return (
    <Suspense fallback={<LoadingState />}>
      <ProjectScope>
        {(project) => <TraceView project={project} traceId={decodeURIComponent(traceId)} />}
      </ProjectScope>
    </Suspense>
  );
}
