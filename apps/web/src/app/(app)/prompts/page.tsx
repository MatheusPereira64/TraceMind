'use client';

import type { GenerationItem, ProjectDto, RepeatedPromptDto } from '@tracemind/shared';
import { GitCompareArrows, MessagesSquare, Repeat, SearchX, X } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { AnalyticsShell, type AnalyticsContext } from '@/components/analytics/analytics-shell';
import { StatusBadge, Tabs } from '@/components/explorer/primitives';
import { traceHref } from '@/components/explorer/project-scope';
import { SearchInput } from '@/components/explorer/search-input';
import { Button, buttonVariants } from '@/components/ui/button';
import { Badge, Card } from '@/components/ui/card';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { useGenerations, useRepeatedPrompts } from '@/hooks/explorer';
import { formatMs, formatNumber, formatShortDateTime, formatUsd } from '@/lib/format';
import { cn } from '@/lib/utils';

type View = 'generations' | 'repeated';

function GenerationRow({
  item,
  project,
  selected,
  onToggle,
  selectable,
}: {
  item: GenerationItem;
  project: ProjectDto;
  selected: boolean;
  onToggle: () => void;
  selectable: boolean;
}) {
  return (
    <li className={cn('flex gap-3 px-5 py-3', selected && 'bg-primary/5')}>
      <input
        type="checkbox"
        className="mt-1 size-4 shrink-0 accent-[var(--primary)]"
        checked={selected}
        disabled={!selected && !selectable}
        onChange={onToggle}
        aria-label={`Select call from ${formatShortDateTime(item.startedAt)} for comparison`}
      />
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          <span className="font-mono">{formatShortDateTime(item.startedAt)}</span>
          <span className="font-mono text-foreground">{item.model ?? '—'}</span>
          <StatusBadge status={item.status} />
          <Link
            href={traceHref(project.id, item.traceId, item.spanId)}
            className="truncate hover:text-primary"
          >
            {item.traceName} › {item.spanName}
          </Link>
        </div>
        <p className="line-clamp-2 text-sm">
          <span className="mr-1.5 font-mono text-[11px] uppercase text-subtle">Prompt</span>
          {item.promptPreview || <span className="italic text-subtle">empty</span>}
        </p>
        <p className="line-clamp-2 text-sm text-muted">
          <span className="mr-1.5 font-mono text-[11px] uppercase text-subtle">Response</span>
          {item.responsePreview || <span className="italic text-subtle">no response</span>}
        </p>
      </div>
      <dl className="hidden shrink-0 grid-cols-[auto_auto] gap-x-3 gap-y-0.5 text-right font-mono text-xs tabular-nums sm:grid">
        <dt className="text-subtle">latency</dt>
        <dd>{formatMs(item.durationMs)}</dd>
        <dt className="text-subtle">tokens</dt>
        <dd>
          {formatNumber(item.inputTokens)} → {formatNumber(item.outputTokens)}
        </dd>
        <dt className="text-subtle">cost</dt>
        <dd>{item.costUsd ? formatUsd(item.costUsd) : '—'}</dd>
      </dl>
    </li>
  );
}

function Generations({ project, query, update }: AnalyticsContext) {
  const params = useSearchParams();
  const q = params.get('q') ?? '';
  const inputHash = params.get('hash') ?? undefined;
  const generations = useGenerations(project.id, query, { q: q || undefined, inputHash });
  const items = generations.data?.pages.flatMap((page) => page.items) ?? [];
  const [selected, setSelected] = useState<string[]>([]);
  const toggle = (uid: string) =>
    setSelected((current) =>
      current.includes(uid)
        ? current.filter((entry) => entry !== uid)
        : [...current, uid].slice(-2),
    );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput
          label="Search prompts and responses"
          placeholder="Search prompts and responses…"
          value={q}
          onChange={(value) => update({ q: value })}
        />
        {inputHash ? (
          <span className="inline-flex h-8 items-center gap-1.5 rounded-md border border-primary/40 bg-primary/10 pl-2.5 pr-1 text-xs text-primary">
            Same prompt <span className="font-mono">{inputHash.slice(0, 8)}</span>
            <button
              type="button"
              aria-label="Show all prompts"
              className="rounded p-1 hover:bg-primary/20"
              onClick={() => update({ hash: undefined })}
            >
              <X className="size-3.5" />
            </button>
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-2 text-xs text-muted">
          {selected.length === 0
            ? 'Select two calls to compare'
            : `${selected.length} of 2 selected`}
          {selected.length === 2 ? (
            <Link
              href={`/prompts/compare?project=${project.id}&a=${selected[0]}&b=${selected[1]}`}
              className={buttonVariants({ size: 'sm' })}
            >
              <GitCompareArrows /> Compare
            </Link>
          ) : null}
          {selected.length > 0 ? (
            <Button variant="ghost" size="sm" onClick={() => setSelected([])}>
              Clear
            </Button>
          ) : null}
        </div>
      </div>

      <Card className="min-w-0">
        {generations.isPending ? (
          <LoadingState />
        ) : generations.isError ? (
          <ErrorState error={generations.error} onRetry={() => generations.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState
            icon={q || inputHash ? SearchX : MessagesSquare}
            title={q || inputHash ? 'No calls match' : 'No LLM calls in this range'}
            description="Search uses whole words from prompts and responses, e.g. refund or “order status”."
          />
        ) : (
          <ol
            className={cn('divide-y divide-border', generations.isPlaceholderData && 'opacity-60')}
          >
            {items.map((item) => (
              <GenerationRow
                key={item.uid}
                item={item}
                project={project}
                selected={selected.includes(item.uid)}
                selectable={selected.length < 2}
                onToggle={() => toggle(item.uid)}
              />
            ))}
          </ol>
        )}
        {generations.hasNextPage ? (
          <div className="border-t border-border px-5 py-3 text-center">
            <Button
              variant="secondary"
              size="sm"
              loading={generations.isFetchingNextPage}
              onClick={() => generations.fetchNextPage()}
            >
              Load more
            </Button>
          </div>
        ) : null}
      </Card>
    </div>
  );
}

function RepeatedTable({
  rows,
  onOpen,
}: {
  rows: RepeatedPromptDto[];
  onOpen: (hash: string) => void;
}) {
  const num = 'whitespace-nowrap px-3 py-2.5 text-right font-mono text-xs tabular-nums';
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[820px] text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted">
            <th className="py-2.5 pl-5 pr-3 font-medium">Prompt</th>
            <th className="px-3 py-2.5 text-right font-medium">Calls</th>
            <th className="px-3 py-2.5 text-right font-medium">Distinct answers</th>
            <th className="px-3 py-2.5 font-medium">Models</th>
            <th className="px-3 py-2.5 text-right font-medium">Avg latency</th>
            <th className="px-3 py-2.5 text-right font-medium">Total cost</th>
            <th className="py-2.5 pl-3 pr-5 text-right font-medium">Last seen</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((row) => (
            <tr key={row.inputHash} className="hover:bg-surface-raised/50">
              <td className="max-w-md py-2.5 pl-5 pr-3">
                <button
                  type="button"
                  className="line-clamp-2 text-left hover:text-primary"
                  onClick={() => onOpen(row.inputHash)}
                >
                  {row.promptPreview}
                </button>
                <span className="font-mono text-[11px] text-subtle">
                  {row.spanNames.join(', ')} · {row.inputHash.slice(0, 8)}
                </span>
              </td>
              <td className={num}>{formatNumber(row.calls)}</td>
              <td className={num}>
                {row.distinctOutputs === 1 ? (
                  <Badge tone="success" title="Every call returned the same answer">
                    1 · cacheable
                  </Badge>
                ) : (
                  formatNumber(row.distinctOutputs)
                )}
              </td>
              <td className="max-w-48 px-3 py-2.5">
                <span className="block truncate font-mono text-[11px] text-muted">
                  {row.models.join(', ')}
                </span>
              </td>
              <td className={num}>{formatMs(row.avgLatencyMs)}</td>
              <td className={num}>{formatUsd(row.totalCostUsd)}</td>
              <td className={cn(num, 'pr-5')}>{formatShortDateTime(row.lastSeenAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Repeated({ project, query, update }: AnalyticsContext) {
  const repeated = useRepeatedPrompts(project.id, query);
  const rows = repeated.data ?? [];
  const calls = rows.reduce((sum, row) => sum + row.calls, 0);
  const cacheable = rows.filter((row) => row.distinctOutputs === 1);
  const cacheableCost = cacheable.reduce(
    (sum, row) => sum + Number(row.totalCostUsd) * ((row.calls - 1) / row.calls),
    0,
  );

  return (
    <div className="space-y-4">
      {rows.length > 0 ? (
        <p className="text-sm text-muted">
          {formatNumber(rows.length)} prompts were sent more than once ({formatNumber(calls)}{' '}
          calls).{' '}
          {cacheable.length > 0 ? (
            <>
              {formatNumber(cacheable.length)} always got the same answer; caching them would have
              saved about{' '}
              <span className="font-mono text-foreground">{formatUsd(cacheableCost)}</span> in this
              range.
            </>
          ) : null}
        </p>
      ) : null}
      <Card className="min-w-0">
        {repeated.isPending ? (
          <LoadingState />
        ) : repeated.isError ? (
          <ErrorState error={repeated.error} onRetry={() => repeated.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={Repeat}
            title="No repeated prompts"
            description="Prompts are grouped when the full input (system prompt and messages) is identical."
          />
        ) : (
          <RepeatedTable
            rows={rows}
            onOpen={(hash) => update({ view: undefined, hash, q: undefined })}
          />
        )}
      </Card>
    </div>
  );
}

function PromptsView(context: AnalyticsContext) {
  const view: View = useSearchParams().get('view') === 'repeated' ? 'repeated' : 'generations';
  return (
    <div className="space-y-5">
      <Tabs<View>
        label="Prompt history views"
        value={view}
        onChange={(next) =>
          context.update({ view: next === 'generations' ? undefined : next, hash: undefined })
        }
        tabs={[
          { id: 'generations', label: 'LLM calls' },
          { id: 'repeated', label: 'Repeated prompts' },
        ]}
      />
      {view === 'repeated' ? <Repeated {...context} /> : <Generations {...context} />}
    </div>
  );
}

export default function PromptsPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <AnalyticsShell
        title="Prompts"
        description="Every prompt and response sent to a model: search, compare and find repeats."
      >
        {(context) => <PromptsView {...context} />}
      </AnalyticsShell>
    </Suspense>
  );
}
