'use client';

import { SPAN_KINDS, type SpanKind, type TraceStatus } from '@tracemind/shared';
import {
  Bot,
  Boxes,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  Database,
  Link2,
  Sparkles,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { useState } from 'react';
import { cn } from '@/lib/utils';
import { SERIES } from '../analytics/chart-kit';
import { CopyButton } from '../ui/copy-button';

/** Span kinds keep the categorical slots in their declared order, on every trace. */
export const KIND_COLOR: Record<SpanKind, string> = Object.fromEntries(
  SPAN_KINDS.map((kind, index) => [kind, SERIES[index]!]),
) as Record<SpanKind, string>;

const KIND_ICON: Record<SpanKind, LucideIcon> = {
  llm: Sparkles,
  tool: Wrench,
  retrieval: Database,
  chain: Link2,
  embedding: Boxes,
  custom: Bot,
};

export function KindIcon({ kind, className }: { kind: SpanKind; className?: string }) {
  const Icon = KIND_ICON[kind];
  return (
    <Icon
      className={cn('size-3.5 shrink-0', className)}
      style={{ color: KIND_COLOR[kind] }}
      aria-label={kind}
    />
  );
}

/** Status always carries an icon and a word, never color alone. */
export function StatusBadge({ status }: { status: TraceStatus }) {
  const config = {
    success: { icon: CircleCheck, label: 'Success', className: 'text-success' },
    error: { icon: CircleAlert, label: 'Error', className: 'text-danger' },
    running: { icon: CircleDashed, label: 'Running', className: 'text-muted' },
  }[status];
  const Icon = config.icon;
  return (
    <span className={cn('inline-flex items-center gap-1 text-xs', config.className)}>
      <Icon className="size-3.5" aria-hidden />
      {config.label}
    </span>
  );
}

interface Message {
  role: string;
  content: unknown;
}

function asMessages(value: unknown): Message[] | null {
  const list = Array.isArray(value)
    ? value
    : value &&
        typeof value === 'object' &&
        Array.isArray((value as { messages?: unknown }).messages)
      ? (value as { messages: unknown[] }).messages
      : value && typeof value === 'object' && 'role' in value && 'content' in value
        ? [value]
        : null;
  if (!list || list.length === 0) return null;
  return list.every(
    (item) => item && typeof item === 'object' && typeof (item as Message).role === 'string',
  )
    ? (list as Message[])
    : null;
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content
      .map((part) =>
        typeof part === 'string'
          ? part
          : part &&
              typeof part === 'object' &&
              typeof (part as { text?: unknown }).text === 'string'
            ? (part as { text: string }).text
            : JSON.stringify(part),
      )
      .join('\n');
  return JSON.stringify(content, null, 2);
}

const ROLE_TONE: Record<string, string> = {
  system: 'border-l-subtle',
  user: 'border-l-primary',
  assistant: 'border-l-success',
  tool: 'border-l-warning',
};

/**
 * Prompt / completion viewer: chat messages render as a conversation, anything else as JSON.
 * "Raw" always shows the stored payload exactly (after redaction).
 */
export function PayloadView({ value, empty = 'Not recorded' }: { value: unknown; empty?: string }) {
  const [raw, setRaw] = useState(false);
  if (value === null || value === undefined)
    return <p className="text-sm italic text-subtle">{empty}</p>;
  const messages = asMessages(value);
  const json = typeof value === 'string' ? value : JSON.stringify(value, null, 2);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-end gap-1">
        {messages ? (
          <button
            type="button"
            className="h-6 rounded px-2 text-[11px] text-muted hover:bg-surface-raised hover:text-foreground"
            onClick={() => setRaw((current) => !current)}
            aria-pressed={raw}
          >
            {raw ? 'Formatted' : 'Raw JSON'}
          </button>
        ) : null}
        <CopyButton value={json} />
      </div>
      {messages && !raw ? (
        <ol className="space-y-2">
          {messages.map((message, index) => (
            <li
              key={index}
              className={cn(
                'rounded-md border border-border border-l-2 bg-background px-3 py-2',
                ROLE_TONE[message.role] ?? 'border-l-border-strong',
              )}
            >
              <p className="mb-1 font-mono text-[11px] uppercase tracking-wide text-subtle">
                {message.role}
              </p>
              <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                {contentToText(message.content)}
              </p>
            </li>
          ))}
        </ol>
      ) : (
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-background p-3 font-mono text-xs leading-relaxed">
          {json}
        </pre>
      )}
    </div>
  );
}

/** Label / value pairs in a compact grid. */
export function Facts({ items }: { items: Array<[string, React.ReactNode]> }) {
  return (
    <dl className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-x-4 gap-y-3">
      {items.map(([label, value]) => (
        <div key={label} className="min-w-0">
          <dt className="text-xs text-muted">{label}</dt>
          <dd className="mt-0.5 truncate font-mono text-sm tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Simple accessible tabs (buttons with aria-selected); content is rendered by the caller. */
export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
}: {
  tabs: Array<{ id: T; label: string; count?: number }>;
  value: T;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div role="tablist" aria-label={label} className="flex gap-1 border-b border-border">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={value === tab.id}
          onClick={() => onChange(tab.id)}
          className={cn(
            '-mb-px flex h-9 items-center gap-1.5 border-b-2 px-3 text-sm transition-colors',
            value === tab.id
              ? 'border-primary text-foreground'
              : 'border-transparent text-muted hover:text-foreground',
          )}
        >
          {tab.label}
          {tab.count !== undefined ? (
            <span className="font-mono text-[11px] text-subtle">{tab.count}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
