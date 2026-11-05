import { describe, expect, it } from 'vitest';
import {
  createApiKeySchema,
  hasRoleAtLeast,
  registerSchema,
  slugify,
  slugSchema,
  updateProjectSchema,
} from '../src/index.js';

describe('slugify', () => {
  it('normalizes accents, case and separators', () => {
    expect(slugify('  Atendimento  ao Cliente — São Paulo! ')).toBe(
      'atendimento-ao-cliente-sao-paulo',
    );
  });

  it('produces values accepted by slugSchema', () => {
    const slug = slugify('My Project 2026');
    expect(slugSchema.safeParse(slug).success).toBe(true);
  });

  it('never ends with a hyphen after truncation', () => {
    const slug = slugify(`${'a'.repeat(47)} b`);
    expect(slug.endsWith('-')).toBe(false);
  });
});

describe('registerSchema', () => {
  it('lowercases and trims the email', () => {
    const parsed = registerSchema.parse({
      name: 'Ana',
      email: '  Ana@Example.COM ',
      password: 'a-strong-password',
      organizationName: 'Acme',
    });
    expect(parsed.email).toBe('ana@example.com');
  });

  it('rejects short passwords', () => {
    const result = registerSchema.safeParse({
      name: 'Ana',
      email: 'ana@example.com',
      password: 'short',
      organizationName: 'Acme',
    });
    expect(result.success).toBe(false);
  });
});

describe('createApiKeySchema', () => {
  it('defaults environment to development', () => {
    expect(createApiKeySchema.parse({ name: 'ci' }).environment).toBe('development');
  });

  it('rejects an expiry in the past', () => {
    const result = createApiKeySchema.safeParse({ name: 'ci', expiresAt: '2000-01-01T00:00:00Z' });
    expect(result.success).toBe(false);
  });
});

describe('updateProjectSchema', () => {
  it('rejects an empty patch', () => {
    expect(updateProjectSchema.safeParse({}).success).toBe(false);
  });
});

describe('hasRoleAtLeast', () => {
  it('respects role ordering', () => {
    expect(hasRoleAtLeast('owner', 'admin')).toBe(true);
    expect(hasRoleAtLeast('member', 'admin')).toBe(false);
    expect(hasRoleAtLeast('viewer', 'viewer')).toBe(true);
  });
});
