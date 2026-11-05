import type { Environment } from '@tracemind/shared';
import { createHash, randomBytes } from 'node:crypto';

const ENV_TAG: Readonly<Record<Environment, string>> = {
  development: 'dev',
  staging: 'stg',
  production: 'prod',
};

/** Number of secret characters shown in the prefix (after `tm_<env>_`). */
const VISIBLE_SECRET_CHARS = 8;

/** Shape: tm_<env>_<32 base64url chars>; the random part carries 192 bits of entropy. */
const KEY_PATTERN = /^tm_(dev|stg|prod)_[A-Za-z0-9_-]{32}$/;

export interface GeneratedApiKey {
  key: string;
  prefix: string;
  hash: string;
}

export function generateApiKey(environment: Environment): GeneratedApiKey {
  const secret = randomBytes(24).toString('base64url');
  const key = `tm_${ENV_TAG[environment]}_${secret}`;
  const prefix = key.slice(0, key.length - secret.length + VISIBLE_SECRET_CHARS);
  return { key, prefix, hash: hashApiKey(key) };
}

/**
 * SHA-256 is sufficient here: unlike passwords, keys are uniformly random with 192 bits of
 * entropy, so brute force over the hash is infeasible and lookups can use an indexed equality.
 */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

export function looksLikeApiKey(value: string): boolean {
  return KEY_PATTERN.test(value);
}
