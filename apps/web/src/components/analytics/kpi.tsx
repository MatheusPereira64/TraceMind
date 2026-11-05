import { ArrowDownRight, ArrowUpRight, Info } from 'lucide-react';
import { relativeChange } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * Stat tile: one number, its trend versus the previous period of equal length, and what "better"
 * means for this metric (lower latency is good, lower requests is just less traffic).
 */
export function Kpi({
  label,
  value,
  current,
  previous,
  better = 'neutral',
  hint,
  loading,
}: {
  label: string;
  value: string;
  current?: number;
  previous?: number;
  better?: 'up' | 'down' | 'neutral';
  hint?: string;
  loading?: boolean;
}) {
  const change =
    current !== undefined && previous !== undefined ? relativeChange(current, previous) : null;
  const direction =
    change === null || Math.abs(change) < 0.005 ? 'flat' : change > 0 ? 'up' : 'down';
  const tone =
    direction === 'flat' || better === 'neutral'
      ? 'neutral'
      : direction === better
        ? 'good'
        : 'bad';

  return (
    <div className="min-w-0 rounded-lg border border-border bg-surface px-4 py-3.5">
      <dt className="flex items-center gap-1 text-xs text-muted">
        {label}
        {hint ? (
          <span title={hint} className="inline-flex cursor-help">
            <Info className="size-3 text-subtle" aria-label={hint} />
          </span>
        ) : null}
      </dt>
      <dd className="mt-1.5">
        {loading ? (
          <span className="block h-7 w-24 animate-pulse rounded bg-surface-raised" />
        ) : (
          <span className="block truncate text-2xl font-semibold tracking-tight">{value}</span>
        )}
      </dd>
      <dd className="mt-1 h-4 truncate text-xs">
        {!loading && change !== null && direction !== 'flat' ? (
          <span
            className={cn(
              'inline-flex items-center gap-0.5 whitespace-nowrap',
              tone === 'good' && 'text-status-good',
              tone === 'bad' && 'text-status-critical',
              tone === 'neutral' && 'text-muted',
            )}
          >
            {direction === 'up' ? (
              <ArrowUpRight className="size-3" aria-hidden />
            ) : (
              <ArrowDownRight className="size-3" aria-hidden />
            )}
            {Math.abs(change * 100).toFixed(change !== 0 && Math.abs(change) < 0.1 ? 1 : 0)}%
            <span className="ml-1 text-subtle">vs prev. period</span>
          </span>
        ) : !loading && change !== null ? (
          <span className="text-subtle">no change vs prev. period</span>
        ) : null}
      </dd>
    </div>
  );
}

export function KpiGrid({ children }: { children: React.ReactNode }) {
  return <dl className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">{children}</dl>;
}
