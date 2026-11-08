'use client';

import { SPAN_KINDS, type SpanDto } from '@tracemind/shared';
import { AlertTriangle } from 'lucide-react';
import { useMemo } from 'react';
import { formatMs, formatUsd } from '@/lib/format';
import { buildSpanTimeline, timelineTicks } from '@/lib/span-tree';
import { cn } from '@/lib/utils';
import { Legend } from '../analytics/chart-kit';
import { KIND_COLOR, KindIcon } from './primitives';

const INDENT_PX = 14;

/**
 * Where a bar's duration label fits: after the bar, else before it, else (a bar spanning nearly
 * the whole timeline) inside it.
 */
function labelPlacement(offsetMs: number, widthMs: number, totalMs: number) {
  if (offsetMs + widthMs <= totalMs * 0.72) return 'after' as const;
  if (offsetMs >= totalMs * 0.3) return 'before' as const;
  return 'inside' as const;
}

/**
 * Execution timeline: one row per span in tree order, a bar positioned by start offset and sized
 * by duration. Rows are buttons (keyboard and screen-reader friendly); the selected span is
 * highlighted and its details render in the side panel.
 */
export function Waterfall({
  spans,
  trace,
  selectedId,
  onSelect,
}: {
  spans: SpanDto[];
  trace: { startedAt: string; endedAt: string | null };
  selectedId: string | undefined;
  onSelect: (spanId: string) => void;
}) {
  const timeline = useMemo(() => buildSpanTimeline(spans, trace), [spans, trace]);
  const ticks = timelineTicks(timeline.totalMs);
  const percent = (ms: number) => `${(ms / timeline.totalMs) * 100}%`;
  const kinds = SPAN_KINDS.filter((kind) => spans.some((span) => span.kind === kind));

  return (
    <div>
      <div className="grid grid-cols-[minmax(11rem,2fr)_minmax(8rem,3fr)] border-b border-border text-[11px] text-subtle">
        <div className="px-4 py-2">Span</div>
        <div className="relative mr-4 h-8" aria-hidden>
          {ticks.map((tick) => (
            <span
              key={tick}
              className={cn(
                'absolute top-2 whitespace-nowrap font-mono tabular-nums',
                tick === 0
                  ? ''
                  : tick >= timeline.totalMs * 0.95
                    ? '-translate-x-full'
                    : '-translate-x-1/2',
              )}
              style={{ left: percent(tick) }}
            >
              {formatMs(tick)}
            </span>
          ))}
        </div>
      </div>
      <ol aria-label="Spans">
        {timeline.rows.map(({ span, depth, offsetMs, widthMs }) => {
          const selected = span.id === selectedId;
          const failed = span.status === 'error';
          return (
            <li key={span.uid}>
              <button
                type="button"
                onClick={() => onSelect(span.id)}
                aria-current={selected ? 'true' : undefined}
                className={cn(
                  'grid w-full grid-cols-[minmax(11rem,2fr)_minmax(8rem,3fr)] items-center text-left transition-colors',
                  selected ? 'bg-primary/10' : 'hover:bg-surface-raised/60',
                )}
              >
                <span
                  className="flex min-w-0 items-center gap-1.5 py-1.5 pr-2"
                  style={{ paddingLeft: 16 + depth * INDENT_PX }}
                >
                  <KindIcon kind={span.kind} />
                  <span className="truncate text-sm">{span.name}</span>
                  {failed ? (
                    <AlertTriangle className="size-3.5 shrink-0 text-danger" aria-label="Error" />
                  ) : null}
                  {span.model ? (
                    <span className="hidden truncate font-mono text-[11px] text-subtle 2xl:inline">
                      {span.model}
                    </span>
                  ) : null}
                </span>
                <span className="relative mr-4 h-7">
                  {ticks.map((tick) => (
                    <span
                      key={tick}
                      aria-hidden
                      className="absolute inset-y-0 w-px bg-[var(--chart-grid)]"
                      style={{ left: percent(tick) }}
                    />
                  ))}
                  <span
                    className={cn(
                      'absolute top-1.5 h-4 min-w-[2px] rounded-sm',
                      failed && 'ring-2 ring-danger ring-offset-1 ring-offset-surface',
                    )}
                    style={{
                      left: percent(offsetMs),
                      width: percent(widthMs),
                      background: KIND_COLOR[span.kind],
                      opacity: selected || !selectedId ? 1 : 0.75,
                    }}
                  />
                  <span
                    className={cn(
                      'absolute top-1.5 whitespace-nowrap px-1.5 font-mono text-[11px] leading-4 tabular-nums',
                      labelPlacement(offsetMs, widthMs, timeline.totalMs) === 'inside'
                        ? 'font-medium text-background'
                        : 'text-muted',
                    )}
                    style={
                      {
                        after: { left: percent(offsetMs + widthMs) },
                        before: { right: `calc(100% - ${percent(offsetMs)})` },
                        inside: { left: percent(offsetMs) },
                      }[labelPlacement(offsetMs, widthMs, timeline.totalMs)]
                    }
                  >
                    {span.durationMs === null ? 'running' : formatMs(span.durationMs)}
                    {span.usage?.estimatedCostUsd
                      ? ` · ${formatUsd(span.usage.estimatedCostUsd)}`
                      : ''}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      <div className="border-t border-border px-2 py-2">
        <Legend items={kinds.map((kind) => ({ label: kind, color: KIND_COLOR[kind] }))} />
      </div>
    </div>
  );
}
