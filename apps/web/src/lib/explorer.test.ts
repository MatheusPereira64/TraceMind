import type { SpanDto } from '@tracemind/shared';
import { wordDiff } from './diff';
import { buildSpanTimeline, timelineTicks } from './span-tree';

const T0 = Date.parse('2026-11-01T12:00:00.000Z');
const at = (ms: number) => new Date(T0 + ms).toISOString();

function span(id: string, parentId: string | null, start: number, end: number | null): SpanDto {
  return {
    uid: `uid-${id}`,
    id,
    parentId,
    name: id,
    kind: 'custom',
    status: end === null ? 'running' : 'success',
    provider: null,
    model: null,
    input: null,
    output: null,
    modelParameters: null,
    metadata: {},
    startedAt: at(start),
    endedAt: end === null ? null : at(end),
    durationMs: end === null ? null : end - start,
    usage: null,
    errors: [],
  };
}

describe('buildSpanTimeline', () => {
  it('orders spans depth-first with siblings by start time', () => {
    const timeline = buildSpanTimeline(
      [
        span('answer', 'root', 300, 900),
        span('root', null, 0, 1_000),
        span('classify', 'root', 10, 200),
        span('tool', 'answer', 400, 500),
      ],
      { startedAt: at(0), endedAt: at(1_000) },
    );
    expect(timeline.rows.map((row) => [row.span.id, row.depth])).toEqual([
      ['root', 0],
      ['classify', 1],
      ['answer', 1],
      ['tool', 2],
    ]);
    expect(timeline.rows[3]).toMatchObject({ offsetMs: 400, widthMs: 100 });
    expect(timeline.totalMs).toBe(1_000);
  });

  it('shows orphans as roots and stretches running spans to the end', () => {
    const timeline = buildSpanTimeline(
      [span('child', 'missing-parent', 100, 200), span('running', null, 50, null)],
      { startedAt: at(0), endedAt: null },
    );
    expect(timeline.rows.map((row) => [row.span.id, row.depth])).toEqual([
      ['running', 0],
      ['child', 0],
    ]);
    expect(timeline.rows[0]!.widthMs).toBe(150);
  });

  it('produces round axis ticks', () => {
    expect(timelineTicks(2_000)).toEqual([0, 500, 1_000, 1_500, 2_000]);
    expect(timelineTicks(0)).toEqual([0]);
  });
});

describe('wordDiff', () => {
  it('marks removed and added words and preserves the text', () => {
    const segments = wordDiff('Delivery takes 6 days.', 'Delivery takes 3 days.');
    expect(segments).toEqual([
      { kind: 'same', text: 'Delivery takes ' },
      { kind: 'removed', text: '6 ' },
      { kind: 'added', text: '3 ' },
      { kind: 'same', text: 'days.' },
    ]);
    const after = segments
      .filter((segment) => segment.kind !== 'removed')
      .map((segment) => segment.text)
      .join('');
    expect(after).toBe('Delivery takes 3 days.');
  });

  it('handles identical, empty and oversized inputs', () => {
    expect(wordDiff('same', 'same')).toEqual([{ kind: 'same', text: 'same' }]);
    expect(wordDiff('', '')).toEqual([]);
    expect(wordDiff('a b c', 'x y z', 2)).toEqual([
      { kind: 'removed', text: 'a b c' },
      { kind: 'added', text: 'x y z' },
    ]);
  });
});
