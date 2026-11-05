import { DEFAULT_REDACTION_SETTINGS, INGEST_MAX_STRING_LENGTH } from '@tracemind/shared';
import { Redactor } from './redaction.js';

const redactor = new Redactor(DEFAULT_REDACTION_SETTINGS);
const mask = (text: string) => redactor.redactString(text);

describe('Redactor', () => {
  it.each([
    ['OpenAI project key', `use sk-proj-${'a1B2'.repeat(10)} please`, 'openai_key'],
    ['Anthropic key', `key=sk-ant-api03-${'x'.repeat(40)}`, 'anthropic_key'],
    ['TraceMind key', `tm_prod_${'A'.repeat(32)}`, 'tracemind_key'],
    ['AWS access key', 'AKIAIOSFODNN7EXAMPLE', 'aws_access_key'],
    ['GitHub token', `ghp_${'a'.repeat(36)}`, 'github_token'],
    [
      'JWT',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
      'jwt',
    ],
    ['card number', 'card 4111 1111 1111 1111 exp 12/30', 'card_number'],
    ['email', 'contact ana.souza+test@empresa.com.br now', 'email'],
  ])('masks %s', (_, input, detector) => {
    const output = mask(input);
    expect(output).toContain(`[REDACTED:${detector}]`);
  });

  it('keeps the Bearer prefix readable', () => {
    expect(mask('Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456')).toBe(
      'Authorization: Bearer [REDACTED:bearer_token]',
    );
  });

  it('does not flag numbers that fail the Luhn check', () => {
    expect(mask('order 1234 5678 9012 3456')).toBe('order 1234 5678 9012 3456');
  });

  it('leaves ordinary text untouched', () => {
    const text = 'The refund for order #4512 was approved on 2026-11-05 at 14:00.';
    expect(mask(text)).toBe(text);
  });

  it('masks values of sensitive keys at any depth and counts detections', () => {
    const { value, counts } = redactor.redact({
      headers: { Authorization: 'anything', 'content-type': 'json' },
      nested: [{ api_key: 'k', note: 'mail me at a@b.co' }],
    });
    expect(value).toEqual({
      headers: { Authorization: '[REDACTED:sensitive_key]', 'content-type': 'json' },
      nested: [{ api_key: '[REDACTED:sensitive_key]', note: 'mail me at [REDACTED:email]' }],
    });
    expect(counts).toEqual({ sensitive_key: 2, email: 1 });
  });

  it('applies literal masks, longest first', () => {
    const custom = new Redactor({
      ...DEFAULT_REDACTION_SETTINGS,
      literals: ['acme', 'acme-internal.local'],
    });
    expect(custom.redactString('host acme-internal.local for acme')).toBe(
      'host [REDACTED:literal] for [REDACTED:literal]',
    );
  });

  it('honours disabled settings but still truncates', () => {
    const disabled = new Redactor({ ...DEFAULT_REDACTION_SETTINGS, enabled: false });
    expect(disabled.redactString('mail a@b.co')).toBe('mail a@b.co');
    const long = 'x'.repeat(INGEST_MAX_STRING_LENGTH + 10);
    expect(disabled.redactString(long)).toMatch(/…\[truncated 10 chars\]$/);
  });

  it('masks phone numbers only when enabled', () => {
    expect(mask('call +55 92 99123-4567')).toBe('call +55 92 99123-4567');
    const phones = new Redactor({ ...DEFAULT_REDACTION_SETTINGS, maskPhoneNumbers: true });
    expect(phones.redactString('call +55 92 99123-4567')).toContain('[REDACTED:phone]');
  });

  it('stays fast on adversarial input', () => {
    const adversarial = `${'a'.repeat(50_000)}@${'b.'.repeat(20_000)}`;
    const started = performance.now();
    mask(adversarial);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('does not mutate its input', () => {
    const input = { password: 'p', list: ['a@b.co'] };
    redactor.redact(input);
    expect(input).toEqual({ password: 'p', list: ['a@b.co'] });
  });
});
