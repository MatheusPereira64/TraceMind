import { readFileSync } from 'node:fs';
import { OPEN_START, parseRegistry, undatedModel } from './registry.js';

const entry = (overrides: Record<string, unknown> = {}) => ({
  provider: 'openai',
  model: 'm',
  input: '1.00',
  output: '2.00',
  cachedInput: null,
  effectiveFrom: null,
  effectiveTo: null,
  source: 'https://example.com',
  ...overrides,
});
const file = (models: unknown[]) => ({ verifiedAt: '2026-11-05', models });

describe('price registry', () => {
  it('the committed registry is valid', () => {
    const raw = JSON.parse(
      readFileSync(new URL('../../pricing/models.json', import.meta.url), 'utf8'),
    );
    const rows = parseRegistry(raw);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.source.includes('verified 2026-11-05'))).toBe(true);
  });

  it('maps an open start to the epoch and keeps dated windows', () => {
    const [open, dated] = parseRegistry(
      file([
        entry({ effectiveTo: '2026-12-01T00:00:00Z' }),
        entry({ input: '2.00', effectiveFrom: '2026-12-01T00:00:00Z' }),
      ]),
    );
    expect(open!.effectiveFrom).toEqual(OPEN_START);
    expect(open!.effectiveTo).toEqual(new Date('2026-12-01T00:00:00Z'));
    expect(dated!.effectiveFrom).toEqual(new Date('2026-12-01T00:00:00Z'));
  });

  it('rejects overlapping windows for the same model', () => {
    expect(() =>
      parseRegistry(file([entry(), entry({ effectiveFrom: '2026-12-01T00:00:00Z' })])),
    ).toThrow(/Overlapping/);
    expect(() =>
      parseRegistry(
        file([
          entry({ effectiveTo: '2026-12-15T00:00:00Z' }),
          entry({ effectiveFrom: '2026-12-01T00:00:00Z' }),
        ]),
      ),
    ).toThrow(/Overlapping/);
  });

  it('allows the same window for different models', () => {
    expect(parseRegistry(file([entry(), entry({ model: 'other' })]))).toHaveLength(2);
  });

  it('validates prices and windows', () => {
    expect(() => parseRegistry(file([entry({ input: '-1' })]))).toThrow();
    expect(() => parseRegistry(file([entry({ input: '0.0000001' })]))).toThrow();
    expect(() =>
      parseRegistry(
        file([
          entry({ effectiveFrom: '2026-12-01T00:00:00Z', effectiveTo: '2026-11-01T00:00:00Z' }),
        ]),
      ),
    ).toThrow(/effectiveTo/);
  });
});

describe('undatedModel', () => {
  it.each([
    ['gpt-4.1-2025-04-14', 'gpt-4.1'],
    ['claude-sonnet-4-20250514', 'claude-sonnet-4'],
    ['gpt-6.1-sol', null],
    ['gemini-3.8-flash', null],
  ])('%s → %s', (input, expected) => {
    expect(undatedModel(input)).toBe(expected);
  });
});
