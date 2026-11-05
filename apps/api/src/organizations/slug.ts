import { randomBytes } from 'node:crypto';
import { slugify } from '@tracemind/shared';

/** Slug candidate from a name; falls back to a random slug for names with no ASCII letters. */
export function baseSlug(name: string, fallbackPrefix: string): string {
  const slug = slugify(name);
  return slug.length >= 2 ? slug : `${fallbackPrefix}-${randomSuffix()}`;
}

export function randomSuffix(): string {
  return randomBytes(3).toString('hex');
}

/** Appends a random suffix while keeping the slug within the 48-character limit. */
export function withSuffix(slug: string): string {
  const suffix = randomSuffix();
  return `${slug.slice(0, 48 - suffix.length - 1).replace(/-+$/, '')}-${suffix}`;
}
