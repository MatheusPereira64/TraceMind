import type { ErrorInfoInput, IngestEvent } from '@tracemind/shared';

/**
 * Deterministic simulation of an AI customer-support assistant, used only for the demo project.
 * Every event is marked as simulated; nothing here is real provider usage.
 */

/** Small seeded PRNG (mulberry32) so the demo is reproducible. */
export function createRandom(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const normal = () => {
    const u = Math.max(next(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
  };
  return {
    next,
    int: (min: number, max: number) => Math.floor(min + next() * (max - min + 1)),
    /** Log-normal sample with the given median and spread (sigma in log space). */
    logNormal: (median: number, sigma: number) => median * Math.exp(sigma * normal()),
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!,
    weighted: <T>(items: ReadonlyArray<readonly [T, number]>): T => {
      const total = items.reduce((sum, [, weight]) => sum + weight, 0);
      let roll = next() * total;
      for (const [item, weight] of items) {
        roll -= weight;
        if (roll <= 0) return item;
      }
      return items[items.length - 1]![0];
    },
  };
}
export type Random = ReturnType<typeof createRandom>;

interface ModelProfile {
  provider: string;
  model: string;
  /** Median latency per output token and fixed overhead, in ms. */
  msPerOutputToken: number;
  overheadMs: number;
  /** Share of input tokens served from the prompt cache when caching applies. */
  cacheShare: number;
}

const ANSWER_MODELS: ReadonlyArray<readonly [ModelProfile, number]> = [
  [
    {
      provider: 'openai',
      model: 'gpt-6.1-sol',
      msPerOutputToken: 9,
      overheadMs: 450,
      cacheShare: 0.55,
    },
    38,
  ],
  [
    {
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      msPerOutputToken: 11,
      overheadMs: 520,
      cacheShare: 0.6,
    },
    30,
  ],
  [
    {
      provider: 'google',
      model: 'gemini-3.8-flash',
      msPerOutputToken: 5,
      overheadMs: 300,
      cacheShare: 0.4,
    },
    20,
  ],
  [
    {
      provider: 'openai',
      model: 'gpt-6.1-terra',
      msPerOutputToken: 7,
      overheadMs: 380,
      cacheShare: 0.5,
    },
    12,
  ],
];

const CLASSIFIER_MODELS: ReadonlyArray<readonly [ModelProfile, number]> = [
  [
    {
      provider: 'anthropic',
      model: 'claude-haiku-5-5',
      msPerOutputToken: 4,
      overheadMs: 180,
      cacheShare: 0.7,
    },
    60,
  ],
  [
    {
      provider: 'openai',
      model: 'gpt-6-luna',
      msPerOutputToken: 3,
      overheadMs: 150,
      cacheShare: 0.6,
    },
    40,
  ],
];

const QUESTIONS = [
  ['order_status', 'Where is my order #{n}? It was supposed to arrive yesterday.'],
  ['refund', 'I want a refund for order #{n}, the item arrived damaged.'],
  ['shipping', 'Do you ship to Manaus? How long does delivery take?'],
  [
    'account',
    'I cannot log in to my account, the reset email never arrives. My email is cliente{n}@example.com',
  ],
  ['billing', 'Why was I charged twice on my last invoice?'],
  ['product', 'Is the wireless headset compatible with PlayStation 5?'],
  ['cancel', 'Please cancel my subscription before the next renewal.'],
  ['order_status', 'Can you check the tracking for order #{n}?'],
] as const;

const ANSWERS: Record<string, string> = {
  order_status:
    'Your order #{n} left our warehouse and is with the carrier. Expected delivery: within 2 business days.',
  refund:
    'I am sorry about that. I opened refund request R-{n}; you will receive the amount within 5 business days.',
  shipping: 'Yes, we ship to Manaus. Standard delivery takes 6–9 business days; express takes 3–4.',
  account:
    'I sent a new reset link. If it does not arrive in 10 minutes, check the spam folder or reply here.',
  billing:
    'I found a duplicate authorization that will be released automatically within 3 days. No action needed.',
  product:
    'Yes, it works with PS5 over the USB-C dongle. Bluetooth audio is not supported by the console.',
  cancel:
    'Done: your subscription will not renew. You keep access until the end of the current period.',
};

const SYSTEM_PROMPT =
  'You are Acme Support, a concise and friendly assistant. Use the knowledge base and order tools. Never invent order data.';

export interface SimulatedIncident {
  /** Inclusive start / exclusive end. */
  from: number;
  to: number;
  provider: string;
  rateLimitProbability: number;
}

export interface SimulationOptions {
  random: Random;
  traceId: string;
  start: number;
  /** Extra latency multiplier (e.g. a slow deploy window). */
  latencyFactor: number;
  incidents: SimulatedIncident[];
}

const iso = (ms: number) => new Date(ms).toISOString();

/** Builds the events of one support conversation turn. */
export function simulateConversation(options: SimulationOptions): IngestEvent[] {
  const { random, traceId, latencyFactor } = options;
  const events: IngestEvent[] = [];
  const [intent, template] = random.pick(QUESTIONS);
  const n = random.int(10_000, 99_999);
  const question = template.replaceAll('{n}', String(n));
  const environment = random.next() < 0.86 ? 'production' : 'staging';
  let clock = options.start;
  let failed = false;

  const llmSpan = (
    id: string,
    name: string,
    profile: ModelProfile,
    inputMedian: number,
    outputMedian: number,
    input: unknown,
    output: unknown,
    parameters: Record<string, unknown>,
  ) => {
    const inputTokens = Math.max(50, Math.round(random.logNormal(inputMedian, 0.35)));
    const outputTokens = Math.max(5, Math.round(random.logNormal(outputMedian, 0.45)));
    const cachedInputTokens =
      random.next() < 0.65 ? Math.floor(inputTokens * profile.cacheShare) : 0;
    let duration =
      (profile.overheadMs + outputTokens * profile.msPerOutputToken) *
      random.logNormal(1, 0.25) *
      latencyFactor;

    const incident = options.incidents.find(
      (window) => window.provider === profile.provider && clock >= window.from && clock < window.to,
    );
    const roll = random.next();
    let error: ErrorInfoInput | undefined;
    if (incident && roll < incident.rateLimitProbability) {
      error = {
        type: 'rate_limit',
        message: `${profile.provider}: rate limit exceeded for ${profile.model}`,
        httpStatus: 429,
        code: 'rate_limit_exceeded',
      };
      duration = random.logNormal(220, 0.3);
    } else if (roll < 0.012) {
      error = {
        type: 'rate_limit',
        message: `${profile.provider}: rate limit exceeded for ${profile.model}`,
        httpStatus: 429,
        code: 'rate_limit_exceeded',
      };
      duration = random.logNormal(220, 0.3);
    } else if (roll < 0.018) {
      error = {
        type: 'timeout',
        message: `Request to ${profile.provider} timed out after 30000 ms`,
      };
      duration = 30_000;
    } else if (roll < 0.022) {
      error = {
        type: 'provider_error',
        message: `${profile.provider}: upstream overloaded (529)`,
        httpStatus: 529,
      };
      duration = random.logNormal(900, 0.4);
    }

    const started = clock;
    clock += Math.round(duration);
    events.push({
      type: 'span',
      id,
      traceId,
      parentId: 'agent',
      name,
      kind: 'llm',
      provider: profile.provider,
      model: profile.model,
      input,
      ...(error ? {} : { output }),
      modelParameters: parameters,
      metadata: { simulated: true },
      startTime: iso(started),
      endTime: iso(clock),
      status: error ? 'error' : 'success',
      ...(error ? { error } : {}),
      // Failed calls still consume (and are billed for) input tokens.
      usage: { inputTokens, outputTokens: error ? 0 : outputTokens, cachedInputTokens },
    });
    clock += random.int(5, 40);
    return !error;
  };

  const agentStart = clock;
  clock += random.int(2, 15);

  // 1. Intent classification on a small model.
  const classifier = random.weighted(CLASSIFIER_MODELS);
  if (
    !llmSpan(
      'classify',
      'classify-intent',
      classifier,
      420,
      12,
      [
        { role: 'system', content: 'Classify the customer intent.' },
        { role: 'user', content: question },
      ],
      { role: 'assistant', content: intent },
      { temperature: 0, max_tokens: 20 },
    )
  ) {
    failed = true;
  }

  // 2. Retrieval and (for order questions) a tool call.
  if (!failed) {
    const retrievalMs = Math.round(random.logNormal(120, 0.4));
    events.push({
      type: 'span',
      id: 'retrieve',
      traceId,
      parentId: 'agent',
      name: 'search-knowledge-base',
      kind: 'retrieval',
      input: { query: question, topK: 5 },
      output: { documents: random.int(2, 5) },
      metadata: { simulated: true, index: 'support-articles-v3' },
      startTime: iso(clock),
      endTime: iso(clock + retrievalMs),
    });
    clock += retrievalMs + random.int(3, 20);

    if (intent === 'order_status' || intent === 'refund') {
      const toolMs = Math.round(random.logNormal(180, 0.5));
      const toolFailed = random.next() < 0.015;
      events.push({
        type: 'span',
        id: 'tool',
        traceId,
        parentId: 'agent',
        name: intent === 'refund' ? 'create-refund' : 'lookup-order',
        kind: 'tool',
        input: { orderId: n },
        ...(toolFailed
          ? {}
          : { output: { status: intent === 'refund' ? 'refund_created' : 'in_transit' } }),
        metadata: { simulated: true },
        startTime: iso(clock),
        endTime: iso(clock + toolMs),
        status: toolFailed ? 'error' : 'success',
        ...(toolFailed
          ? {
              error: {
                type: 'tool_call_failed' as const,
                message: 'orders-service responded 503',
                httpStatus: 503,
              },
            }
          : {}),
      });
      clock += toolMs + random.int(3, 20);
      failed = toolFailed;
    }
  }

  // 3. Answer generation on the main model.
  const answer = ANSWERS[intent]!.replaceAll('{n}', String(n));
  if (!failed) {
    const model = random.weighted(ANSWER_MODELS);
    failed = !llmSpan(
      'answer',
      'generate-answer',
      model,
      2_600,
      230,
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: question },
      ],
      { role: 'assistant', content: answer },
      { temperature: 0.3, max_tokens: 800 },
    );
  }

  const end = clock + random.int(2, 15);
  events.push({
    type: 'span',
    id: 'agent',
    traceId,
    name: 'support-agent',
    kind: 'chain',
    metadata: { simulated: true },
    startTime: iso(agentStart),
    endTime: iso(end),
    status: failed ? 'error' : 'success',
  });
  events.unshift({
    type: 'trace',
    id: traceId,
    name: 'customer-support',
    environment,
    userId: `customer-${random.int(1, 2_500)}`,
    sessionId: `session-${random.int(1, 9_000)}`,
    tags: ['simulated', intent],
    metadata: { simulated: true, intent, channel: random.pick(['web', 'whatsapp', 'email']) },
    input: question,
    ...(failed ? {} : { output: answer }),
    startTime: iso(options.start),
    endTime: iso(end),
    status: failed ? 'error' : 'success',
  });

  // 4. User feedback on some conversations, and an offline quality score on others.
  if (!failed && random.next() < 0.16) {
    events.push({
      type: 'evaluation',
      id: `${traceId}:feedback`,
      traceId,
      criterion: 'user_feedback',
      kind: 'thumbs',
      score: random.next() < 0.86 ? 1 : 0,
    });
  }
  if (!failed && random.next() < 0.06) {
    events.push({
      type: 'evaluation',
      id: `${traceId}:helpfulness`,
      traceId,
      spanId: 'answer',
      criterion: 'helpfulness',
      kind: 'numeric',
      score: Math.round(Math.min(1, Math.max(0.2, random.logNormal(0.82, 0.12))) * 100) / 100,
    });
  }
  return events;
}

/**
 * Expected conversations per hour: daytime peak in the given UTC offset, quieter weekends, and
 * slow growth across the window.
 */
export function hourlyRate(
  timeMs: number,
  startMs: number,
  endMs: number,
  utcOffsetHours: number,
  base: number,
): number {
  const local = new Date(timeMs + utcOffsetHours * 3_600_000);
  const hour = local.getUTCHours();
  const weekday = local.getUTCDay();
  const daytime = 0.25 + 0.75 * Math.max(0, Math.sin(((hour - 6) / 16) * Math.PI));
  const weekend = weekday === 0 || weekday === 6 ? 0.55 : 1;
  const growth = 0.75 + 0.5 * ((timeMs - startMs) / Math.max(1, endMs - startMs));
  return base * daytime * weekend * growth;
}
