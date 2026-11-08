import { describe, expect, it } from 'vitest';
import {
  createEvaluationSchema,
  criterionInputSchema,
  payloadText,
  preview,
  tracesQuerySchema,
} from '../src/explorer.js';

describe('payloadText', () => {
  const chat = [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'First question' },
    { role: 'assistant', content: 'First answer' },
    { role: 'user', content: 'Where is my order?' },
  ];

  it('uses the last user message for prompts', () => {
    expect(payloadText(chat, 'prompt')).toBe('Where is my order?');
    expect(payloadText({ messages: chat }, 'prompt')).toBe('Where is my order?');
  });

  it('reads assistant messages, OpenAI choices and content parts for responses', () => {
    expect(payloadText({ role: 'assistant', content: 'It ships today.' }, 'response')).toBe(
      'It ships today.',
    );
    expect(
      payloadText({ choices: [{ message: { role: 'assistant', content: 'Hi' } }] }, 'response'),
    ).toBe('Hi');
    expect(
      payloadText(
        [{ role: 'user', content: [{ type: 'text', text: 'Look' }, { type: 'image' }] }],
        'prompt',
      ),
    ).toBe('Look');
  });

  it('falls back to strings and compact JSON', () => {
    expect(payloadText('plain', 'prompt')).toBe('plain');
    expect(payloadText({ query: 'refund', topK: 5 }, 'prompt')).toBe('{"query":"refund","topK":5}');
    expect(payloadText(null, 'response')).toBe('');
  });

  it('truncates previews on a single line', () => {
    expect(preview('a\n  b')).toBe('a b');
    expect(preview('x'.repeat(10), 5)).toBe('xxxx…');
  });
});

describe('explorer schemas', () => {
  const range = { from: '2026-11-01T00:00:00Z', to: '2026-11-02T00:00:00Z' };

  it('parses trace filters with defaults', () => {
    const query = tracesQuerySchema.parse({ ...range, q: '  refund ', minDurationMs: '1500' });
    expect(query).toMatchObject({ q: 'refund', minDurationMs: 1500, limit: 50, tz: 'UTC' });
  });

  it('validates criterion definitions', () => {
    expect(
      criterionInputSchema.safeParse({
        name: 'helpfulness',
        kind: 'numeric',
        minScore: 0,
        maxScore: 1,
      }).success,
    ).toBe(true);
    expect(
      criterionInputSchema.safeParse({ name: 'x', kind: 'numeric', minScore: 1, maxScore: 1 })
        .success,
    ).toBe(false);
    expect(
      criterionInputSchema.safeParse({ name: 'tone', kind: 'categorical', labels: ['ok', 'ok'] })
        .success,
    ).toBe(false);
    expect(criterionInputSchema.safeParse({ name: 'has space', kind: 'thumbs' }).success).toBe(
      false,
    );
  });

  it('validates manual evaluations by kind', () => {
    expect(
      createEvaluationSchema.safeParse({ criterion: 'user_feedback', kind: 'thumbs', score: 1 })
        .success,
    ).toBe(true);
    expect(
      createEvaluationSchema.safeParse({ criterion: 'user_feedback', kind: 'thumbs', score: 0.5 })
        .success,
    ).toBe(false);
    expect(
      createEvaluationSchema.safeParse({ criterion: 'tone', kind: 'categorical' }).success,
    ).toBe(false);
  });
});
