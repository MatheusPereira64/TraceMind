'use client';

import type {
  BreakdownRow,
  CostsDto,
  ErrorItem,
  PerformanceDto,
  PricingRowDto,
} from '@tracemind/shared';
import { ExternalLink } from 'lucide-react';
import type { ReactNode } from 'react';
import {
  formatMs,
  formatNumber,
  formatPercent,
  formatShortDateTime,
  formatUsd,
} from '@/lib/format';
import { cn } from '@/lib/utils';
import { Badge } from '../ui/card';
import { ERROR_TYPE_LABEL, errorTypeColor } from './charts';

function Table({
  head,
  children,
  minWidth = 640,
}: {
  head: ReactNode[];
  children: ReactNode;
  minWidth?: number;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" style={{ minWidth }}>
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted">
            {head.map((cell, index) => (
              <th
                key={index}
                className={cn(
                  'px-3 py-2.5 font-medium first:pl-5 last:pr-5',
                  index > 0 && 'text-right',
                )}
              >
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">{children}</tbody>
      </table>
    </div>
  );
}

const cell = 'px-3 py-2.5 first:pl-5 last:pr-5';
const numCell = cn(cell, 'whitespace-nowrap text-right font-mono text-xs tabular-nums');

/** Copyable trace id: the Trace Explorer (next release) will turn this into a link. */
function TraceRef({ id, name }: { id: string; name: string }) {
  return (
    <span className="block min-w-0">
      <span className="block truncate">{name}</span>
      <span className="block truncate font-mono text-[11px] text-subtle" title={id}>
        {id}
      </span>
    </span>
  );
}

export function ModelsTable({
  rows,
  colorFor,
}: {
  rows: BreakdownRow[];
  colorFor: (model: string) => string;
}) {
  return (
    <Table
      head={[
        'Model',
        'Requests',
        'Error rate',
        'Tokens in / out',
        'Avg latency',
        'p95 latency',
        'Est. cost',
        'Share',
      ]}
    >
      {rows.map((row) => (
        <tr key={`${row.provider}/${row.model}`}>
          <td className={cell}>
            <span className="flex items-center gap-2">
              <span
                aria-hidden
                className="size-2.5 shrink-0 rounded-sm"
                style={{ background: colorFor(row.model ?? '') }}
              />
              <span className="min-w-0">
                <span className="block truncate font-medium">{row.model ?? '(unknown)'}</span>
                <span className="block text-xs text-subtle">{row.provider ?? '—'}</span>
              </span>
            </span>
          </td>
          <td className={numCell}>{formatNumber(row.requests)}</td>
          <td className={numCell}>
            {row.requests ? formatPercent(row.errors / row.requests) : '—'}
          </td>
          <td className={numCell}>
            {formatNumber(row.inputTokens)} / {formatNumber(row.outputTokens)}
          </td>
          <td className={numCell}>{formatMs(row.avgLatencyMs)}</td>
          <td className={numCell}>{formatMs(row.p95LatencyMs)}</td>
          <td className={numCell}>{formatUsd(row.costUsd)}</td>
          <td className={numCell}>{formatPercent(row.costShare, 0)}</td>
        </tr>
      ))}
    </Table>
  );
}

export function TopRequestsTable({ rows }: { rows: CostsDto['topRequests'] }) {
  return (
    <Table head={['Request', 'Model', 'Tokens in / out', 'Started', 'Est. cost']} minWidth={560}>
      {rows.map((row, index) => (
        <tr key={`${row.traceId}-${index}`}>
          <td className={cn(cell, 'max-w-56')}>
            <TraceRef id={row.traceId} name={`${row.traceName} › ${row.spanName}`} />
          </td>
          <td className={cn(cell, 'whitespace-nowrap text-right text-xs')}>{row.model ?? '—'}</td>
          <td className={numCell}>
            {formatNumber(row.inputTokens)} / {formatNumber(row.outputTokens)}
          </td>
          <td className={cn(cell, 'whitespace-nowrap text-right text-xs text-muted')}>
            {formatShortDateTime(row.startedAt)}
          </td>
          <td className={numCell}>{formatUsd(row.costUsd)}</td>
        </tr>
      ))}
    </Table>
  );
}

export function SlowestTable({ rows }: { rows: PerformanceDto['slowest'] }) {
  return (
    <Table head={['Request', 'Model', 'Status', 'Started', 'Duration']} minWidth={560}>
      {rows.map((row, index) => (
        <tr key={`${row.traceId}-${index}`}>
          <td className={cn(cell, 'max-w-56')}>
            <TraceRef id={row.traceId} name={`${row.traceName} › ${row.spanName}`} />
          </td>
          <td className={cn(cell, 'whitespace-nowrap text-right text-xs')}>{row.model ?? '—'}</td>
          <td className={cn(cell, 'text-right')}>
            <Badge tone={row.status === 'error' ? 'danger' : 'success'}>{row.status}</Badge>
          </td>
          <td className={cn(cell, 'whitespace-nowrap text-right text-xs text-muted')}>
            {formatShortDateTime(row.startedAt)}
          </td>
          <td className={numCell}>{formatMs(row.durationMs)}</td>
        </tr>
      ))}
    </Table>
  );
}

export function ErrorsTable({ rows }: { rows: ErrorItem[] }) {
  return (
    <Table head={['Error', 'Type', 'Model', 'Request', 'When']} minWidth={760}>
      {rows.map((row) => (
        <tr key={row.id} className="align-top">
          <td className={cn(cell, 'max-w-80')}>
            <span className="block break-words text-sm">{row.message}</span>
            {row.code || row.httpStatus ? (
              <span className="mt-0.5 block font-mono text-[11px] text-subtle">
                {[row.httpStatus, row.code].filter(Boolean).join(' · ')}
              </span>
            ) : null}
          </td>
          <td className={cn(cell, 'text-right')}>
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs text-muted">
              <span
                aria-hidden
                className="size-2 rounded-sm"
                style={{ background: errorTypeColor(row.type) }}
              />
              {ERROR_TYPE_LABEL[row.type]}
            </span>
          </td>
          <td className={cn(cell, 'whitespace-nowrap text-right text-xs')}>{row.model ?? '—'}</td>
          <td className={cn(cell, 'max-w-56 text-right')}>
            <TraceRef
              id={row.traceId}
              name={row.spanName ? `${row.traceName} › ${row.spanName}` : row.traceName}
            />
          </td>
          <td className={cn(cell, 'whitespace-nowrap text-right text-xs text-muted')}>
            {formatShortDateTime(row.occurredAt)}
          </td>
        </tr>
      ))}
    </Table>
  );
}

export function PricingTable({ rows }: { rows: PricingRowDto[] }) {
  // Price changes take effect at 00:00 UTC; show them in UTC so they do not shift a day.
  const date = (iso: string) =>
    new Date(iso).toLocaleDateString('en', { dateStyle: 'medium', timeZone: 'UTC' });
  return (
    <Table
      head={['Model', 'Input / 1M', 'Cached input / 1M', 'Output / 1M', 'Valid', 'Source']}
      minWidth={720}
    >
      {rows.map((row) => {
        const url = row.source?.match(/https?:\/\/\S+/)?.[0];
        return (
          <tr key={`${row.provider}/${row.model}/${row.effectiveFrom}`}>
            <td className={cell}>
              <span className="block font-medium">{row.model}</span>
              <span className="block text-xs text-subtle">{row.provider}</span>
            </td>
            <td className={numCell}>{formatUsd(row.inputPricePerMillion)}</td>
            <td className={numCell}>
              {row.cachedInputPricePerMillion ? formatUsd(row.cachedInputPricePerMillion) : '—'}
            </td>
            <td className={numCell}>{formatUsd(row.outputPricePerMillion)}</td>
            <td className={cn(cell, 'whitespace-nowrap text-right text-xs text-muted')}>
              {row.effectiveFrom && row.effectiveTo
                ? `${date(row.effectiveFrom)} – ${date(row.effectiveTo)}`
                : row.effectiveFrom
                  ? `from ${date(row.effectiveFrom)}`
                  : row.effectiveTo
                    ? `until ${date(row.effectiveTo)}`
                    : 'current'}
            </td>
            <td className={cn(cell, 'text-right')}>
              {url ? (
                <a
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-muted hover:text-foreground"
                >
                  {new URL(url).hostname} <ExternalLink className="size-3" aria-hidden />
                </a>
              ) : null}
            </td>
          </tr>
        );
      })}
    </Table>
  );
}
