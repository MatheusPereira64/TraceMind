import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { validateAgainst } from './evaluations.service.js';

describe('validateAgainst', () => {
  const numeric = {
    name: 'accuracy',
    kind: 'numeric' as const,
    minScore: 1,
    maxScore: 5,
    labels: [],
  };
  const categorical = {
    name: 'resolution',
    kind: 'categorical' as const,
    minScore: null,
    maxScore: null,
    labels: ['resolved', 'unresolved'],
  };

  it('accepts scores inside the scale, including the bounds', () => {
    expect(() => validateAgainst(numeric, { kind: 'numeric', score: 1 })).not.toThrow();
    expect(() => validateAgainst(numeric, { kind: 'numeric', score: 5 })).not.toThrow();
  });

  it('rejects out-of-scale scores and kind mismatches', () => {
    expect(() => validateAgainst(numeric, { kind: 'numeric', score: 5.5 })).toThrow(
      BadRequestException,
    );
    expect(() => validateAgainst(numeric, { kind: 'thumbs', score: 1 })).toThrow(/expects numeric/);
  });

  it('only accepts defined labels for categorical criteria', () => {
    expect(() =>
      validateAgainst(categorical, { kind: 'categorical', label: 'resolved' }),
    ).not.toThrow();
    expect(() => validateAgainst(categorical, { kind: 'categorical', label: 'maybe' })).toThrow(
      /one of: resolved, unresolved/,
    );
  });
});
