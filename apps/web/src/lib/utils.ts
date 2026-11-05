import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

const relativeFormatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
  ['second', 1],
];

/** "3 minutes ago" / "in 2 days". `now` is injectable for deterministic tests. */
export function formatRelative(iso: string, now: number = Date.now()): string {
  const diffSeconds = Math.round((new Date(iso).getTime() - now) / 1000);
  for (const [unit, seconds] of UNITS) {
    if (Math.abs(diffSeconds) >= seconds || unit === 'second') {
      return relativeFormatter.format(Math.round(diffSeconds / seconds), unit);
    }
  }
  return relativeFormatter.format(0, 'second');
}

export function formatDate(iso: string): string {
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(new Date(iso));
}
