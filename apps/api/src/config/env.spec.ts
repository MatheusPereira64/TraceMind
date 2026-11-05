import { loadEnv } from './env.js';

const base = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'x'.repeat(32),
};

describe('loadEnv', () => {
  it('applies defaults', () => {
    const env = loadEnv(base);
    expect(env.PORT).toBe(4000);
    expect(env.WEB_ORIGIN).toEqual(['http://localhost:3000']);
    expect(env.TRUST_PROXY).toBe(false);
    expect(env.COOKIE_SECURE).toBeUndefined();
  });

  it('splits multiple web origins', () => {
    const env = loadEnv({ ...base, WEB_ORIGIN: 'https://a.dev, https://b.dev' });
    expect(env.WEB_ORIGIN).toEqual(['https://a.dev', 'https://b.dev']);
  });

  it('rejects weak secrets and wrong protocols with a readable message', () => {
    expect(() => loadEnv({ ...base, JWT_SECRET: 'short' })).toThrow(/JWT_SECRET/);
    expect(() => loadEnv({ ...base, DATABASE_URL: 'mysql://localhost/db' })).toThrow(
      /DATABASE_URL/,
    );
  });

  it('parses boolean flags', () => {
    expect(loadEnv({ ...base, TRUST_PROXY: 'true', COOKIE_SECURE: '0' })).toMatchObject({
      TRUST_PROXY: true,
      COOKIE_SECURE: false,
    });
  });
});
