import type { SpanDto } from '@tracemind/shared';

export interface SpanRow {
  span: SpanDto;
  depth: number;
  /** Offset of the span start from the trace start, in ms. */
  offsetMs: number;
  /** Duration used for drawing (running spans extend to the end of the timeline). */
  widthMs: number;
  hasChildren: boolean;
}

export interface SpanTimeline {
  rows: SpanRow[];
  startMs: number;
  totalMs: number;
}

/**
 * Flattens spans into a depth-first list (children right after their parent, siblings by start
 * time) with timeline offsets. Spans whose parent is missing are shown as roots, so a partially
 * ingested trace still renders every span. Cycles cannot occur (the API rejects self-parenting
 * and parents are resolved by id), but a visited set guards against them anyway.
 */
export function buildSpanTimeline(
  spans: SpanDto[],
  trace: { startedAt: string; endedAt: string | null },
): SpanTimeline {
  const ids = new Set(spans.map((span) => span.id));
  const children = new Map<string | null, SpanDto[]>();
  for (const span of spans) {
    const parent = span.parentId && ids.has(span.parentId) ? span.parentId : null;
    children.set(parent, [...(children.get(parent) ?? []), span]);
  }
  for (const list of children.values())
    list.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));

  const ends = spans.map((span) => Date.parse(span.endedAt ?? span.startedAt));
  const startMs = Math.min(
    Date.parse(trace.startedAt),
    ...spans.map((s) => Date.parse(s.startedAt)),
  );
  const endMs = Math.max(trace.endedAt ? Date.parse(trace.endedAt) : startMs, ...ends, startMs + 1);

  const rows: SpanRow[] = [];
  const visited = new Set<string>();
  const visit = (span: SpanDto, depth: number) => {
    if (visited.has(span.id)) return;
    visited.add(span.id);
    const start = Date.parse(span.startedAt);
    const end = span.endedAt ? Date.parse(span.endedAt) : endMs;
    const kids = children.get(span.id) ?? [];
    rows.push({
      span,
      depth,
      offsetMs: start - startMs,
      widthMs: Math.max(0, end - start),
      hasChildren: kids.length > 0,
    });
    for (const child of kids) visit(child, depth + 1);
  };
  for (const root of children.get(null) ?? []) visit(root, 0);
  return { rows, startMs, totalMs: endMs - startMs };
}

/** Evenly spaced, round tick values (ms) for a timeline axis of the given length. */
export function timelineTicks(totalMs: number, target = 5): number[] {
  if (totalMs <= 0) return [0];
  const raw = totalMs / target;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((factor) => factor * magnitude).find((s) => s >= raw)!;
  const ticks: number[] = [];
  for (let value = 0; value <= totalMs + step * 0.001; value += step) ticks.push(value);
  return ticks;
}
