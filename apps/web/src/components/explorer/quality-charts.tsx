'use client';

import type { BucketSize, CriterionSummary } from '@tracemind/shared';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatBucketLabel, formatNumber, formatPercent } from '@/lib/format';
import { browserTimeZone } from '@/lib/time-range';
import { axisProps, gridProps, SERIES, tooltip } from '../analytics/chart-kit';

/** How a criterion's average reads: thumbs as "% positive", numeric as the score itself. */
export function formatAverage(summary: Pick<CriterionSummary, 'kind'>, value: number | null) {
  if (value === null) return '—';
  return summary.kind === 'thumbs' ? formatPercent(value, 0) : value.toFixed(2);
}

/**
 * Average score per interval for one criterion (one series, so no legend: the card title names
 * it). Empty intervals are gaps, not zeros: no evaluations is not a bad score.
 */
export function QualityTrendChart({
  summary,
  bucket,
  height = 180,
}: {
  summary: CriterionSummary;
  bucket: BucketSize;
  height?: number;
}) {
  const tz = browserTimeZone();
  const label = (value: string) => formatBucketLabel(value, bucket, tz);
  const definition = summary.definition;
  const domain: [number | 'auto', number | 'auto'] =
    summary.kind === 'thumbs'
      ? [0, 1]
      : [definition?.minScore ?? 'auto', definition?.maxScore ?? 'auto'];
  const data = summary.series.map((point) => ({ ...point, count: point.count }));

  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid {...gridProps} />
        <XAxis dataKey="t" {...axisProps} tickFormatter={label} minTickGap={28} />
        <YAxis
          {...axisProps}
          width={44}
          domain={domain}
          tickFormatter={(value: number) => formatAverage(summary, value)}
        />
        <Tooltip
          content={tooltip(
            (value, name) =>
              name === 'Evaluations' ? formatNumber(value) : formatAverage(summary, value),
            label,
          )}
        />
        <Line
          isAnimationActive={false}
          type="monotone"
          dataKey="average"
          name={summary.kind === 'thumbs' ? 'Positive' : 'Average'}
          stroke={SERIES[0]}
          strokeWidth={2}
          dot={{ r: 2.5, fill: SERIES[0], strokeWidth: 0 }}
          activeDot={{ r: 4, stroke: 'var(--surface)', strokeWidth: 2 }}
          connectNulls={false}
        />
        {/* Volume appears in the tooltip only: an invisible series on a hidden axis, so the score
            axis keeps its own scale and no second axis is drawn. */}
        <YAxis yAxisId="volume" hide />
        <Line
          yAxisId="volume"
          isAnimationActive={false}
          dataKey="count"
          name="Evaluations"
          stroke="none"
          dot={false}
          activeDot={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

/** Label distribution for categorical criteria, in the definition's label order. */
export function LabelBars({ summary }: { summary: CriterionSummary }) {
  const order = summary.definition?.labels ?? summary.labels.map((entry) => entry.label);
  const counts = new Map(summary.labels.map((entry) => [entry.label, entry.count]));
  const labels = [
    ...order,
    ...summary.labels.map((entry) => entry.label).filter((label) => !order.includes(label)),
  ];
  const total = Math.max(
    1,
    summary.labels.reduce((sum, entry) => sum + entry.count, 0),
  );
  return (
    <ul className="space-y-3 px-2 py-2">
      {labels.map((label, index) => {
        const count = counts.get(label) ?? 0;
        return (
          <li key={label}>
            <div className="mb-1 flex items-baseline justify-between gap-3 text-sm">
              <span className="flex items-center gap-1.5">
                <span
                  aria-hidden
                  className="inline-block size-2.5 rounded-sm"
                  style={{ background: SERIES[index % SERIES.length] }}
                />
                {label}
              </span>
              <span className="font-mono text-xs tabular-nums text-muted">
                {formatNumber(count)} · {formatPercent(count / total, 0)}
              </span>
            </div>
            <div className="h-2 rounded-sm bg-surface-raised">
              <div
                className="h-2 rounded-sm"
                style={{
                  width: `${(count / total) * 100}%`,
                  background: SERIES[index % SERIES.length],
                }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
