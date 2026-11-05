'use client';

import {
  ERROR_TYPES,
  type BreakdownRow,
  type ErrorType,
  type PerformanceDto,
  type TimeseriesDto,
} from '@tracemind/shared';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatBucketLabel, formatMs, formatNumber, formatUsd } from '@/lib/format';
import { browserTimeZone } from '@/lib/time-range';
import { axisProps, gridProps, Legend, SERIES, tooltip } from './chart-kit';

const HEIGHT = 240;
const tz = () => browserTimeZone();

function bucketTicks(bucket: string) {
  return (value: string) => formatBucketLabel(value, bucket, tz());
}

/* ------------------------------------------------------------ request volume */

export function RequestsChart({ data }: { data: TimeseriesDto }) {
  const rows = data.points.map((point) => ({
    t: point.t,
    succeeded: point.requests - point.errors,
    failed: point.errors,
  }));
  return (
    <>
      <ResponsiveContainer width="100%" height={HEIGHT}>
        <BarChart data={rows} barCategoryGap={rows.length > 40 ? 1 : '20%'}>
          <CartesianGrid {...gridProps} />
          <XAxis
            dataKey="t"
            {...axisProps}
            tickFormatter={bucketTicks(data.bucket)}
            minTickGap={32}
          />
          <YAxis {...axisProps} width={44} tickFormatter={formatNumber} allowDecimals={false} />
          <Tooltip
            cursor={{ fill: 'var(--surface-raised)' }}
            content={tooltip((value) => formatNumber(value), bucketTicks(data.bucket))}
          />
          <Bar
            isAnimationActive={false}
            dataKey="succeeded"
            name="Succeeded"
            stackId="r"
            fill={SERIES[0]}
            stroke="var(--surface)"
            strokeWidth={1}
          />
          <Bar
            isAnimationActive={false}
            dataKey="failed"
            name="Failed"
            stackId="r"
            fill="var(--status-critical)"
            stroke="var(--surface)"
            strokeWidth={1}
            radius={[3, 3, 0, 0]}
          />
        </BarChart>
      </ResponsiveContainer>
      <Legend
        items={[
          { label: 'Succeeded', color: SERIES[0]! },
          { label: 'Failed', color: 'var(--status-critical)' },
        ]}
      />
    </>
  );
}

/* -------------------------------------------------------------------- tokens */

export function TokensChart({ data }: { data: TimeseriesDto }) {
  return (
    <>
      <ResponsiveContainer width="100%" height={HEIGHT}>
        <AreaChart data={data.points}>
          <CartesianGrid {...gridProps} />
          <XAxis
            dataKey="t"
            {...axisProps}
            tickFormatter={bucketTicks(data.bucket)}
            minTickGap={32}
          />
          <YAxis {...axisProps} width={44} tickFormatter={formatNumber} />
          <Tooltip content={tooltip((value) => formatNumber(value), bucketTicks(data.bucket))} />
          <Area
            isAnimationActive={false}
            type="monotone"
            dataKey="inputTokens"
            name="Input tokens"
            stackId="t"
            stroke={SERIES[0]}
            strokeWidth={2}
            fill={SERIES[0]}
            fillOpacity={0.25}
          />
          <Area
            isAnimationActive={false}
            type="monotone"
            dataKey="outputTokens"
            name="Output tokens"
            stackId="t"
            stroke={SERIES[1]}
            strokeWidth={2}
            fill={SERIES[1]}
            fillOpacity={0.25}
          />
        </AreaChart>
      </ResponsiveContainer>
      <Legend
        items={[
          { label: 'Input tokens', color: SERIES[0]! },
          { label: 'Output tokens', color: SERIES[1]! },
        ]}
      />
    </>
  );
}

/* ------------------------------------------------------------------- latency */

export function LatencyChart({ data }: { data: TimeseriesDto }) {
  const lines = [
    { key: 'p50LatencyMs', label: 'p50', color: SERIES[0]! },
    { key: 'p95LatencyMs', label: 'p95', color: SERIES[1]! },
    { key: 'p99LatencyMs', label: 'p99', color: SERIES[2]! },
  ];
  return (
    <>
      <ResponsiveContainer width="100%" height={HEIGHT}>
        <LineChart data={data.points}>
          <CartesianGrid {...gridProps} />
          <XAxis
            dataKey="t"
            {...axisProps}
            tickFormatter={bucketTicks(data.bucket)}
            minTickGap={32}
          />
          <YAxis {...axisProps} width={52} tickFormatter={(value: number) => formatMs(value)} />
          <Tooltip content={tooltip((value) => formatMs(value), bucketTicks(data.bucket))} />
          {lines.map((line) => (
            <Line
              isAnimationActive={false}
              key={line.key}
              type="monotone"
              dataKey={line.key}
              name={line.label}
              stroke={line.color}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, stroke: 'var(--surface)', strokeWidth: 2 }}
              connectNulls={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
      <Legend
        items={lines.map((line) => ({ label: `${line.label} latency`, color: line.color }))}
      />
    </>
  );
}

/* --------------------------------------------------------- cost by model bar */

export function CostByModelChart({
  rows,
  colorFor,
}: {
  rows: BreakdownRow[];
  colorFor: (model: string) => string;
}) {
  const data = rows
    .filter((row) => Number(row.costUsd) > 0)
    .map((row) => ({
      model: row.model ?? '(unknown)',
      cost: Number(row.costUsd),
      share: row.costShare,
    }));
  return (
    <ResponsiveContainer width="100%" height={Math.max(160, data.length * 40 + 20)}>
      <BarChart data={data} layout="vertical" margin={{ right: 72, left: 8 }} barCategoryGap="28%">
        <XAxis type="number" hide />
        <YAxis
          type="category"
          dataKey="model"
          {...axisProps}
          axisLine={false}
          width={140}
          tick={{ fill: 'var(--muted)', fontSize: 12 }}
        />
        <Tooltip
          cursor={{ fill: 'var(--surface-raised)' }}
          content={tooltip((value) => formatUsd(value))}
        />
        <Bar isAnimationActive={false} dataKey="cost" name="Estimated cost" radius={[0, 4, 4, 0]}>
          {data.map((entry) => (
            <Cell key={entry.model} fill={colorFor(entry.model)} />
          ))}
          <LabelList
            dataKey="cost"
            position="right"
            className="fill-[var(--muted)] text-xs"
            formatter={(value) => formatUsd(Number(value))}
          />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/* ------------------------------------------------------ cost over time stacked */

export function CostOverTimeChart({
  series,
  bucket,
  colorFor,
  models,
}: {
  series: Array<{ t: string; model: string; costUsd: number }>;
  bucket: string;
  colorFor: (model: string) => string;
  models: string[];
}) {
  const byTime = new Map<string, Record<string, number | string>>();
  for (const point of series) {
    const row = byTime.get(point.t) ?? { t: point.t };
    row[point.model] = point.costUsd;
    byTime.set(point.t, row);
  }
  const data = [...byTime.values()].sort((a, b) => String(a.t).localeCompare(String(b.t)));
  const present = models.filter((model) => series.some((point) => point.model === model));
  return (
    <>
      <ResponsiveContainer width="100%" height={HEIGHT}>
        <BarChart data={data} barCategoryGap={data.length > 40 ? 1 : '20%'}>
          <CartesianGrid {...gridProps} />
          <XAxis dataKey="t" {...axisProps} tickFormatter={bucketTicks(bucket)} minTickGap={32} />
          <YAxis {...axisProps} width={56} tickFormatter={(value: number) => formatUsd(value)} />
          <Tooltip
            cursor={{ fill: 'var(--surface-raised)' }}
            content={tooltip((value) => formatUsd(value), bucketTicks(bucket))}
          />
          {present.map((model, index) => (
            <Bar
              isAnimationActive={false}
              key={model}
              dataKey={model}
              name={model}
              stackId="cost"
              fill={colorFor(model)}
              stroke="var(--surface)"
              strokeWidth={1}
              radius={index === present.length - 1 ? [3, 3, 0, 0] : 0}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
      <Legend items={present.map((model) => ({ label: model, color: colorFor(model) }))} />
    </>
  );
}

/* ----------------------------------------------------------- latency histogram */

export function LatencyHistogram({ data }: { data: PerformanceDto['histogram'] }) {
  const seconds = (ms: number) => `${ms / 1000}`;
  const rows = data.map((bin) => ({
    label:
      bin.toMs === null
        ? `≥${seconds(bin.fromMs)}s`
        : bin.fromMs === 0
          ? `<${seconds(bin.toMs)}s`
          : `${seconds(bin.fromMs)}–${seconds(bin.toMs)}s`,
    requests: bin.requests,
  }));
  return (
    <ResponsiveContainer width="100%" height={HEIGHT}>
      <BarChart data={rows} barCategoryGap="12%">
        <CartesianGrid {...gridProps} />
        <XAxis
          dataKey="label"
          {...axisProps}
          interval={0}
          tick={{ fill: 'var(--chart-axis)', fontSize: 10 }}
        />
        <YAxis {...axisProps} width={44} tickFormatter={formatNumber} allowDecimals={false} />
        <Tooltip
          cursor={{ fill: 'var(--surface-raised)' }}
          content={tooltip((value) => `${formatNumber(value)} requests`)}
        />
        <Bar
          isAnimationActive={false}
          dataKey="requests"
          name="Requests"
          fill={SERIES[0]}
          radius={[4, 4, 0, 0]}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}

/* ---------------------------------------------------------- errors over time */

export const ERROR_TYPE_LABEL: Record<ErrorType, string> = {
  provider_error: 'Provider error',
  api_failure: 'API failure',
  rate_limit: 'Rate limit',
  timeout: 'Timeout',
  invalid_response: 'Invalid response',
  tool_call_failed: 'Tool call failed',
  unknown: 'Unknown',
};

/**
 * Fixed color per error type (identity, not severity). The types that occur most often (provider
 * errors, rate limits, timeouts, tool failures) take slots 1, 2, 3 and 5 so they never sit next to
 * a similar hue in a stack.
 */
const ERROR_TYPE_SLOT: Record<ErrorType, number | null> = {
  provider_error: 0,
  rate_limit: 1,
  timeout: 2,
  api_failure: 3,
  tool_call_failed: 4,
  invalid_response: 5,
  unknown: null,
};

export function errorTypeColor(type: ErrorType): string {
  const slot = ERROR_TYPE_SLOT[type];
  return slot === null ? 'var(--chart-axis)' : SERIES[slot]!;
}

export function ErrorsOverTimeChart({
  series,
  points,
  bucket,
}: {
  series: Array<{ t: string; type: ErrorType; count: number }>;
  points: string[];
  bucket: string;
}) {
  const byTime = new Map<string, Record<string, number | string>>(points.map((t) => [t, { t }]));
  for (const point of series) {
    const row = byTime.get(point.t) ?? { t: point.t };
    row[point.type] = point.count;
    byTime.set(point.t, row);
  }
  const data = [...byTime.values()].sort((a, b) => String(a.t).localeCompare(String(b.t)));
  const types = ERROR_TYPES.filter((type) => series.some((point) => point.type === type));
  return (
    <>
      <ResponsiveContainer width="100%" height={HEIGHT}>
        <BarChart data={data} barCategoryGap={data.length > 40 ? 1 : '20%'}>
          <CartesianGrid {...gridProps} />
          <XAxis dataKey="t" {...axisProps} tickFormatter={bucketTicks(bucket)} minTickGap={32} />
          <YAxis {...axisProps} width={36} allowDecimals={false} />
          <Tooltip
            cursor={{ fill: 'var(--surface-raised)' }}
            content={tooltip((value) => formatNumber(value), bucketTicks(bucket))}
          />
          {types.map((type, index) => (
            <Bar
              isAnimationActive={false}
              key={type}
              dataKey={type}
              name={ERROR_TYPE_LABEL[type]}
              stackId="errors"
              fill={errorTypeColor(type)}
              stroke="var(--surface)"
              strokeWidth={1}
              radius={index === types.length - 1 ? [3, 3, 0, 0] : 0}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
      <Legend
        items={types.map((type) => ({
          label: ERROR_TYPE_LABEL[type],
          color: errorTypeColor(type),
        }))}
      />
    </>
  );
}
