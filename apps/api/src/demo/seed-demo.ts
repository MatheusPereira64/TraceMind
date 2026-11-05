/**
 * `pnpm demo:seed` — creates the demo workspace and fills it with SIMULATED telemetry.
 *
 *   Login:  demo@tracemind.dev / DEMO_PASSWORD (default "tracemind-demo")
 *   Flags:  --days=60  --rate=14 (peak conversations per hour)  --seed=42
 *
 * Events go through the same redaction and persistence code as real ingestion (IngestionProcessor)
 * but skip the HTTP/queue hop. Every trace is flagged is_simulated and the project is_demo, and the
 * dashboard labels them; re-running replaces the previous demo telemetry.
 */
import { DEFAULT_REDACTION_SETTINGS, type IngestEvent } from '@tracemind/shared';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PasswordService } from '../auth/password.service.js';
import type { Database } from '../database/database.module.js';
import * as schema from '../database/schema.js';
import { IngestionProcessor } from '../ingestion/ingestion.processor.js';
import { PricingService } from '../ingestion/pricing.service.js';
import { Redactor } from '../ingestion/redaction.js';
import {
  createRandom,
  hourlyRate,
  simulateConversation,
  type SimulatedIncident,
} from './simulation.js';

const DEMO_EMAIL = 'demo@tracemind.dev';
const HOUR = 3_600_000;
const MANAUS_OFFSET = -4;

function flag(name: string, fallback: number): number {
  const raw = process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split('=')[1];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} must be a positive number`);
  return value;
}

async function ensureWorkspace(db: Database, password: string) {
  const passwords = new PasswordService();
  let user = await db.query.users.findFirst({ where: eq(schema.users.email, DEMO_EMAIL) });
  if (!user) {
    [user] = await db
      .insert(schema.users)
      .values({
        email: DEMO_EMAIL,
        name: 'Demo User',
        passwordHash: await passwords.hash(password),
      })
      .returning();
  }

  let organization = await db.query.organizations.findFirst({
    where: eq(schema.organizations.slug, 'acme-demo'),
  });
  if (!organization) {
    [organization] = await db
      .insert(schema.organizations)
      .values({ name: 'Acme (demo)', slug: 'acme-demo' })
      .returning();
  }
  await db
    .insert(schema.organizationMembers)
    .values({ organizationId: organization!.id, userId: user!.id, role: 'owner' })
    .onConflictDoNothing();

  let project = await db.query.projects.findFirst({
    where: and(
      eq(schema.projects.organizationId, organization!.id),
      eq(schema.projects.slug, 'support-assistant'),
    ),
  });
  if (!project) {
    [project] = await db
      .insert(schema.projects)
      .values({
        organizationId: organization!.id,
        name: 'Customer Support Assistant',
        slug: 'support-assistant',
        description:
          'Simulated telemetry of an AI support agent (intent classifier, RAG, tools, answer model).',
        retentionDays: 90,
        isDemo: true,
      })
      .returning();
  }
  return { projectId: project!.id };
}

async function main(): Promise<void> {
  const envFile = new URL('../../.env', import.meta.url);
  if (process.env.NODE_ENV !== 'production' && existsSync(envFile)) process.loadEnvFile(envFile);
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');

  const days = flag('days', 60);
  const peakRate = flag('rate', 14);
  const random = createRandom(flag('seed', 42));

  const pool = new pg.Pool({ connectionString: url, max: 4 });
  const db = drizzle(pool, { schema }) as unknown as Database;
  try {
    const { projectId } = await ensureWorkspace(db, process.env.DEMO_PASSWORD ?? 'tracemind-demo');
    // Replace previous demo telemetry (cascades to spans, usage, errors and evaluations).
    await db.delete(schema.traces).where(eq(schema.traces.projectId, projectId));
    await db
      .delete(schema.ingestionFailures)
      .where(eq(schema.ingestionFailures.projectId, projectId));

    const end = Math.floor(Date.now() / HOUR) * HOUR;
    const start = end - days * 24 * HOUR;
    // Story beats: a provider rate-limit incident and a slow deploy that was rolled back.
    const incidentStart = end - 9 * 24 * HOUR + 13 * HOUR;
    const incidents: SimulatedIncident[] = [
      {
        from: incidentStart,
        to: incidentStart + 6 * HOUR,
        provider: 'anthropic',
        rateLimitProbability: 0.7,
      },
    ];
    const slowFrom = end - 19 * 24 * HOUR;
    const slowTo = slowFrom + 30 * HOUR;

    const processor = new IngestionProcessor(db, new PricingService(db));
    const redactor = new Redactor(DEFAULT_REDACTION_SETTINGS);
    let conversations = 0;
    let events = 0;

    for (let hour = start; hour < end; hour += HOUR) {
      const expected = hourlyRate(hour, start, end, MANAUS_OFFSET, peakRate);
      const count = Math.max(
        0,
        Math.round(expected + (random.next() - 0.5) * Math.sqrt(expected) * 2),
      );
      const batch: IngestEvent[] = [];
      for (let i = 0; i < count; i += 1) {
        const startMs = hour + Math.floor(random.next() * HOUR);
        batch.push(
          ...simulateConversation({
            random,
            traceId: `demo-${startMs.toString(36)}-${i}`,
            start: startMs,
            latencyFactor: startMs >= slowFrom && startMs < slowTo ? 1.9 : 1,
            incidents,
          }),
        );
      }
      if (batch.length === 0) continue;
      await processor.process({
        projectId,
        environment: 'production',
        events: redactor.redact(batch).value,
        receivedAt: new Date(hour).toISOString(),
        simulated: true,
      });
      conversations += count;
      events += batch.length;
      if ((hour - start) % (24 * HOUR) === 0) {
        process.stdout.write(
          `\r  day ${Math.round((hour - start) / (24 * HOUR)) + 1}/${days} · ${conversations} conversations`,
        );
      }
    }
    console.log(
      `\nDemo ready: ${conversations} simulated conversations (${events} events) over ${days} days.`,
    );
    console.log(
      `Sign in with ${DEMO_EMAIL} / ${process.env.DEMO_PASSWORD ? '$DEMO_PASSWORD' : 'tracemind-demo'}`,
    );
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error('Demo seed failed:', error);
    process.exit(1);
  });
}
