const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const integer = new Intl.NumberFormat('en', { maximumFractionDigits: 0 });

export function formatNumber(value: number): string {
  return Math.abs(value) >= 10_000 ? compact.format(value) : integer.format(value);
}

/** USD with precision that scales down for small amounts ($0.0042, not $0.00). */
export function formatUsd(value: number | string): string {
  const amount = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(amount)) return '—';
  const abs = Math.abs(amount);
  const digits = abs === 0 ? 2 : abs < 0.01 ? 4 : abs < 0.1 ? 3 : 2;
  return new Intl.NumberFormat('en', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(amount);
}

export function formatMs(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  if (value < 1_000) return `${Math.round(value)} ms`;
  return `${(value / 1_000).toFixed(value < 10_000 ? 2 : 1)} s`;
}

export function formatPercent(fraction: number, digits = 1): string {
  return `${(fraction * 100).toFixed(digits)}%`;
}

/**
 * Relative change between periods, or null when there is no meaningful baseline (a 0 → x jump is
 * not "∞%").
 */
export function relativeChange(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null;
  return (current - previous) / previous;
}

export function formatBucketLabel(iso: string, bucket: string, timeZone: string): string {
  const date = new Date(iso);
  const options: Intl.DateTimeFormatOptions =
    bucket === '1 hour' || bucket === '6 hours'
      ? { month: 'short', day: 'numeric', hour: 'numeric', timeZone }
      : { month: 'short', day: 'numeric', timeZone };
  return new Intl.DateTimeFormat('en', options).format(date);
}

export function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(iso),
  );
}

/** Compact timestamp for dense tables: "Oct 19, 11:16 AM". */
export function formatShortDateTime(iso: string): string {
  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));
}
