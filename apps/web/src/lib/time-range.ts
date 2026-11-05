export const RANGE_PRESETS = [
  { id: '24h', label: '24h', hours: 24 },
  { id: '7d', label: '7d', hours: 24 * 7 },
  { id: '30d', label: '30d', hours: 24 * 30 },
  { id: '90d', label: '90d', hours: 24 * 90 },
] as const;
export type RangePresetId = (typeof RANGE_PRESETS)[number]['id'];

export interface ResolvedRange {
  from: string;
  to: string;
}

const HOUR = 3_600_000;

/**
 * Preset ranges end at the next full hour so repeated renders within the same hour produce the
 * same query (cache hits, stable charts) while still including the most recent data.
 */
export function resolvePreset(id: RangePresetId, now: number = Date.now()): ResolvedRange {
  const preset = RANGE_PRESETS.find((candidate) => candidate.id === id) ?? RANGE_PRESETS[2];
  const to = Math.ceil(now / HOUR) * HOUR;
  return { from: new Date(to - preset.hours * HOUR).toISOString(), to: new Date(to).toISOString() };
}

/** Custom range from two local calendar dates (YYYY-MM-DD), inclusive of the end day. */
export function resolveCustom(fromDate: string, toDate: string): ResolvedRange | null {
  const from = new Date(`${fromDate}T00:00:00`);
  const to = new Date(`${toDate}T00:00:00`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to < from) return null;
  to.setDate(to.getDate() + 1);
  return { from: from.toISOString(), to: to.toISOString() };
}

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
