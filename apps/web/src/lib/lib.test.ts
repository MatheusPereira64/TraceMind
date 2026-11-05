import { ApiError } from './api-client';
import { safeRedirectPath } from './safe-redirect';
import { formatRelative } from './utils';

describe('safeRedirectPath', () => {
  it('keeps same-origin paths', () => {
    expect(safeRedirectPath('/projects/123?tab=keys')).toBe('/projects/123?tab=keys');
  });

  it.each([null, '', 'https://evil.example', '//evil.example', '/\\evil.example', 'projects'])(
    'falls back for %s',
    (value) => {
      expect(safeRedirectPath(value)).toBe('/overview');
    },
  );
});

describe('formatRelative', () => {
  const now = Date.parse('2026-11-05T12:00:00Z');
  it('formats past and future instants', () => {
    expect(formatRelative('2026-11-05T11:57:00Z', now)).toBe('3 minutes ago');
    expect(formatRelative('2026-11-07T12:00:00Z', now)).toBe('in 2 days');
    expect(formatRelative('2026-11-05T12:00:00Z', now)).toBe('now');
  });
});

describe('ApiError', () => {
  it('exposes field-level issues', () => {
    const error = new ApiError(400, {
      message: 'Validation failed',
      issues: [{ path: 'email', message: 'Invalid email' }],
    });
    expect(error.fieldError('email')).toBe('Invalid email');
    expect(error.fieldError('name')).toBeUndefined();
  });

  it('falls back to a status message without a body', () => {
    expect(new ApiError(502, undefined).message).toBe('Request failed with status 502');
  });
});
