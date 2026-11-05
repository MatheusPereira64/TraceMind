'use client';

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Card, CardHeader } from '../ui/card';
import { ErrorState } from '../ui/states';

/** Categorical slots in fixed order. Color follows the entity (see seriesColorMap), never rank. */
export const SERIES = [
  'var(--series-1)',
  'var(--series-2)',
  'var(--series-3)',
  'var(--series-4)',
  'var(--series-5)',
  'var(--series-6)',
];
export const OTHER_COLOR = 'var(--chart-axis)';

/**
 * Stable entity → color map built from the project's full model list (not the filtered result),
 * so filtering never repaints the remaining series. Beyond six entities, the rest share "Other".
 */
export function seriesColorMap(entities: string[]): (entity: string) => string {
  const ordered = [...new Set(entities)];
  return (entity) => {
    const index = ordered.indexOf(entity);
    return index >= 0 && index < SERIES.length ? SERIES[index]! : OTHER_COLOR;
  };
}

export const axisProps = {
  stroke: 'var(--chart-axis)',
  tick: { fill: 'var(--chart-axis)', fontSize: 11 },
  tickLine: false,
  axisLine: { stroke: 'var(--chart-grid)' },
} as const;

export const gridProps = {
  stroke: 'var(--chart-grid)',
  strokeDasharray: '0',
  vertical: false,
} as const;

export function ChartCard({
  title,
  description,
  action,
  loading,
  error,
  onRetry,
  empty,
  height = 260,
  children,
  className,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  empty?: boolean;
  height?: number;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn('flex min-w-0 flex-col', className)}>
      <CardHeader title={title} description={description} action={action} />
      <div className="relative px-3 pb-3 pt-4" style={{ minHeight: height }}>
        {error ? (
          <ErrorState error={error} onRetry={onRetry} />
        ) : loading ? (
          <div
            className="absolute inset-4 animate-pulse rounded-md bg-surface-raised/60"
            aria-label="Loading chart"
            role="status"
          />
        ) : empty ? (
          <div className="flex items-center justify-center text-sm text-muted" style={{ height }}>
            No data in this range.
          </div>
        ) : (
          children
        )}
      </div>
    </Card>
  );
}

/** Legend rendered as HTML so it wraps cleanly and uses text tokens, with a colored swatch. */
export function Legend({
  items,
}: {
  items: Array<{ label: string; color: string; dashed?: boolean }>;
}) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 px-2 pt-2 text-xs text-muted">
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-1.5">
          <span
            aria-hidden
            className={cn(
              'inline-block h-2.5 w-2.5 rounded-sm',
              item.dashed && 'h-0.5 w-3 rounded-none',
            )}
            style={{ background: item.color }}
          />
          {item.label}
        </li>
      ))}
    </ul>
  );
}

interface TooltipEntry {
  value?: unknown;
  name?: unknown;
  color?: string;
  dataKey?: unknown;
}

interface TooltipProps {
  active?: boolean;
  payload?: ReadonlyArray<TooltipEntry>;
  label?: unknown;
}

/** Tooltip shared by every chart: series swatch + label in text ink, value in primary ink. */
export function ChartTooltip({
  active,
  payload,
  label,
  formatLabel,
  formatValue,
}: TooltipProps & {
  formatLabel?: (label: string) => string;
  formatValue: (value: number, name: string) => string;
}) {
  if (!active || !payload?.length) return null;
  const rows = payload.filter((entry) => entry.value !== undefined && entry.value !== null);
  return (
    <div className="min-w-40 rounded-md border border-border-strong bg-surface-raised px-3 py-2 text-xs shadow-xl">
      {label !== undefined && label !== null ? (
        <p className="mb-1.5 font-medium text-foreground">
          {formatLabel ? formatLabel(String(label)) : String(label)}
        </p>
      ) : null}
      <ul className="space-y-1">
        {rows.map((entry) => (
          <li
            key={String(entry.dataKey ?? entry.name)}
            className="flex items-center justify-between gap-4"
          >
            <span className="flex items-center gap-1.5 text-muted">
              <span
                aria-hidden
                className="inline-block size-2 rounded-sm"
                style={{ background: entry.color }}
              />
              {String(entry.name)}
            </span>
            <span className="font-mono tabular-nums text-foreground">
              {formatValue(Number(entry.value), String(entry.name))}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Builds a Recharts `content` renderer around ChartTooltip. */
export function tooltip(
  formatValue: (value: number, name: string) => string,
  formatLabel?: (label: string) => string,
) {
  const render = (props: TooltipProps) => (
    <ChartTooltip
      active={props.active}
      payload={props.payload}
      label={props.label}
      formatValue={formatValue}
      formatLabel={formatLabel}
    />
  );
  return render;
}
