import { ingestEventSchema } from '@tracemind/shared';
import { createRandom, hourlyRate, simulateConversation } from './simulation.js';

const start = Date.parse('2026-11-02T15:00:00Z');

describe('demo simulation', () => {
  it('is deterministic for a given seed', () => {
    const run = () =>
      simulateConversation({
        random: createRandom(7),
        traceId: 't',
        start,
        latencyFactor: 1,
        incidents: [],
      });
    expect(run()).toEqual(run());
  });

  it('only produces events the ingestion API accepts, all flagged as simulated', () => {
    const random = createRandom(1);
    for (let i = 0; i < 300; i += 1) {
      const events = simulateConversation({
        random,
        traceId: `t${i}`,
        start: start + i * 1000,
        latencyFactor: 1,
        incidents: [],
      });
      for (const event of events) {
        const parsed = ingestEventSchema.safeParse(event);
        expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
      }
      const trace = events.find((event) => event.type === 'trace');
      expect(trace).toMatchObject({
        tags: expect.arrayContaining(['simulated']),
        metadata: { simulated: true },
      });
    }
  });

  it('raises the rate-limit share during an incident window', () => {
    const count = (incident: boolean) => {
      const random = createRandom(3);
      let rateLimited = 0;
      for (let i = 0; i < 400; i += 1) {
        const events = simulateConversation({
          random,
          traceId: `t${i}`,
          start,
          latencyFactor: 1,
          incidents: incident
            ? [
                {
                  from: start - 1,
                  to: start + 3_600_000,
                  provider: 'anthropic',
                  rateLimitProbability: 0.9,
                },
              ]
            : [],
        });
        rateLimited += events.filter(
          (event) => event.type === 'span' && event.error?.type === 'rate_limit',
        ).length;
      }
      return rateLimited;
    };
    expect(count(true)).toBeGreaterThan(count(false) * 3);
  });

  it('follows a daytime and weekday traffic pattern', () => {
    const range = [Date.parse('2026-10-01T00:00:00Z'), Date.parse('2026-11-01T00:00:00Z')] as const;
    const at = (iso: string) => hourlyRate(Date.parse(iso), range[0], range[1], -4, 10);
    expect(at('2026-10-14T18:00:00Z')).toBeGreaterThan(at('2026-10-14T07:00:00Z')); // 14h vs 3h local
    expect(at('2026-10-14T18:00:00Z')).toBeGreaterThan(at('2026-10-18T18:00:00Z')); // Wednesday vs Sunday
  });
});
