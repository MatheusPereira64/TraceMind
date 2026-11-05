import { generateApiKey, hashApiKey, looksLikeApiKey } from './api-key.util.js';

describe('api key utilities', () => {
  it('generates environment-tagged keys with a non-secret prefix', () => {
    const { key, prefix, hash } = generateApiKey('production');
    expect(key).toMatch(/^tm_prod_[A-Za-z0-9_-]{32}$/);
    expect(prefix).toBe(key.slice(0, 'tm_prod_'.length + 8));
    expect(hash).toBe(hashApiKey(key));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('uses distinct tags per environment', () => {
    expect(generateApiKey('development').key.startsWith('tm_dev_')).toBe(true);
    expect(generateApiKey('staging').key.startsWith('tm_stg_')).toBe(true);
  });

  it('never repeats keys', () => {
    const keys = new Set(Array.from({ length: 500 }, () => generateApiKey('development').key));
    expect(keys.size).toBe(500);
  });

  it('recognizes only well-formed keys', () => {
    expect(looksLikeApiKey(generateApiKey('staging').key)).toBe(true);
    expect(looksLikeApiKey('tm_dev_short')).toBe(false);
    expect(looksLikeApiKey('sk-proj-abcdefghijklmnopqrstuvwxyz012345')).toBe(false);
    expect(looksLikeApiKey(`tm_live_${'a'.repeat(32)}`)).toBe(false);
  });
});
