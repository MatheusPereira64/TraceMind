'use client';

import { payloadText, type GenerationDetailDto, type ProjectDto } from '@tracemind/shared';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, type ReactNode } from 'react';
import { PageHeader } from '@/components/app-shell';
import { StatusBadge } from '@/components/explorer/primitives';
import { ProjectScope, traceHref } from '@/components/explorer/project-scope';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { ErrorState, LoadingState } from '@/components/ui/states';
import { useGeneration } from '@/hooks/explorer';
import { wordDiff } from '@/lib/diff';
import { formatDateTime, formatMs, formatNumber, formatUsd } from '@/lib/format';
import { cn } from '@/lib/utils';

/** Text of a payload for diffing: chat messages become "role: content" lines. */
function diffText(value: unknown, role: 'prompt' | 'response'): string {
  if (Array.isArray(value))
    return value
      .map((message) =>
        message && typeof message === 'object' && 'role' in message
          ? `${String((message as { role: unknown }).role)}: ${payloadText([message], role)}`
          : JSON.stringify(message),
      )
      .join('\n\n');
  return payloadText(value, role);
}

function Diff({ before, after }: { before: string; after: string }) {
  const segments = wordDiff(before, after);
  if (segments.length === 0) return <p className="text-sm italic text-subtle">Both empty</p>;
  const identical = segments.length === 1 && segments[0]!.kind === 'same';
  return (
    <div>
      {identical ? <p className="mb-2 text-xs text-success">Identical</p> : null}
      <p className="whitespace-pre-wrap break-words rounded-md border border-border bg-background p-3 text-sm leading-relaxed">
        {segments.map((segment, index) =>
          segment.kind === 'same' ? (
            <span key={index}>{segment.text}</span>
          ) : segment.kind === 'removed' ? (
            <del key={index} className="rounded-sm bg-danger/15 text-danger decoration-danger/60">
              {segment.text}
            </del>
          ) : (
            <ins key={index} className="rounded-sm bg-success/15 text-success no-underline">
              {segment.text}
            </ins>
          ),
        )}
      </p>
    </div>
  );
}

type Row = [label: string, a: string, b: string];

function MetaTable({ a, b }: { a: GenerationDetailDto; b: GenerationDetailDto }) {
  const params = (detail: GenerationDetailDto) =>
    JSON.stringify(detail.span.modelParameters ?? {}, null, 0);
  const rows: Row[] = [
    ['Model', a.span.model ?? '—', b.span.model ?? '—'],
    ['Provider', a.span.provider ?? '—', b.span.provider ?? '—'],
    ['Parameters', params(a), params(b)],
    ['Latency', formatMs(a.span.durationMs), formatMs(b.span.durationMs)],
    [
      'Input tokens',
      formatNumber(a.span.usage?.inputTokens ?? 0),
      formatNumber(b.span.usage?.inputTokens ?? 0),
    ],
    [
      'Output tokens',
      formatNumber(a.span.usage?.outputTokens ?? 0),
      formatNumber(b.span.usage?.outputTokens ?? 0),
    ],
    [
      'Estimated cost',
      a.span.usage?.estimatedCostUsd ? formatUsd(a.span.usage.estimatedCostUsd) : '—',
      b.span.usage?.estimatedCostUsd ? formatUsd(b.span.usage.estimatedCostUsd) : '—',
    ],
    ['Started', formatDateTime(a.span.startedAt), formatDateTime(b.span.startedAt)],
  ];
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted">
            <th className="w-36 py-2.5 pl-5 pr-3 font-medium" />
            <th className="px-3 py-2.5 font-medium">A</th>
            <th className="py-2.5 pl-3 pr-5 font-medium">B</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map(([label, left, right]) => {
            const differs = left !== right;
            return (
              <tr key={label}>
                <th scope="row" className="py-2 pl-5 pr-3 text-left text-xs font-medium text-muted">
                  {label}
                  {differs ? (
                    <span className="ml-1.5 text-warning" title="Different">
                      ≠
                    </span>
                  ) : null}
                </th>
                {[left, right].map((value, index) => (
                  <td
                    key={index}
                    className={cn(
                      'break-all px-3 py-2 font-mono text-xs last:pr-5',
                      differs ? 'text-foreground' : 'text-muted',
                    )}
                  >
                    {value}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Side({
  label,
  detail,
  project,
  children,
}: {
  label: string;
  detail: GenerationDetailDto;
  project: ProjectDto;
  children: ReactNode;
}) {
  return (
    <Card className="min-w-0">
      <CardHeader
        title={`${label} · ${detail.span.model ?? detail.span.name}`}
        description={
          <Link
            href={traceHref(project.id, detail.traceId, detail.span.id)}
            className="font-mono text-xs hover:text-primary"
          >
            {detail.traceId}
          </Link>
        }
        action={<StatusBadge status={detail.span.status} />}
      />
      <div className="px-5 py-4">{children}</div>
    </Card>
  );
}

function Compare({ project }: { project: ProjectDto }) {
  const params = useSearchParams();
  const a = useGeneration(project.id, params.get('a') ?? undefined);
  const b = useGeneration(project.id, params.get('b') ?? undefined);
  const back = (
    <Link
      href={`/prompts?project=${project.id}`}
      className={buttonVariants({ variant: 'ghost', size: 'sm' })}
    >
      <ArrowLeft /> Prompts
    </Link>
  );

  if (!params.get('a') || !params.get('b'))
    return (
      <>
        <PageHeader title="Compare calls" actions={back} />
        <Card className="px-5 py-8 text-center text-sm text-muted">
          Select two LLM calls on the Prompts page to compare them.
        </Card>
      </>
    );
  if (a.isPending || b.isPending) return <LoadingState />;
  if (a.isError || b.isError)
    return <ErrorState error={a.error ?? b.error} onRetry={() => (a.isError ? a : b).refetch()} />;

  const left = a.data;
  const right = b.data;
  return (
    <div className="space-y-6">
      <PageHeader
        title="Compare calls"
        description="Differences are highlighted: removed in A → added in B."
        actions={back}
      />
      <Card className="min-w-0">
        <CardHeader title="Configuration and usage" />
        <MetaTable a={left} b={right} />
      </Card>
      <div className="grid gap-6 lg:grid-cols-2">
        <Side label="A" detail={left} project={project}>
          <h3 className="mb-2 text-xs font-medium text-muted">Prompt</h3>
          <p className="whitespace-pre-wrap break-words rounded-md border border-border bg-background p-3 text-sm leading-relaxed">
            {diffText(left.span.input, 'prompt')}
          </p>
          <h3 className="mb-2 mt-4 text-xs font-medium text-muted">Response</h3>
          <p className="whitespace-pre-wrap break-words rounded-md border border-border bg-background p-3 text-sm leading-relaxed">
            {diffText(left.span.output, 'response') || '—'}
          </p>
        </Side>
        <Side label="B" detail={right} project={project}>
          <h3 className="mb-2 text-xs font-medium text-muted">Prompt (vs A)</h3>
          <Diff
            before={diffText(left.span.input, 'prompt')}
            after={diffText(right.span.input, 'prompt')}
          />
          <h3 className="mb-2 mt-4 text-xs font-medium text-muted">Response (vs A)</h3>
          <Diff
            before={diffText(left.span.output, 'response')}
            after={diffText(right.span.output, 'response')}
          />
        </Side>
      </div>
    </div>
  );
}

export default function ComparePage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <ProjectScope>{(project) => <Compare project={project} />}</ProjectScope>
    </Suspense>
  );
}
