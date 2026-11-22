import type { NestExpressApplication } from '@nestjs/platform-express';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import request from 'supertest';
import { purgeExpiredTelemetry } from '../src/retention/retention.js';
import { RetentionScheduler } from '../src/retention/retention.scheduler.js';
import { bearer, createTestApp, setupProjectWithKey } from './test-app.js';

const NOW = new Date('2026-11-20T12:00:00.000Z');
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

describe('Retention (e2e)', () => {
  let app: NestExpressApplication;
  let pool: pg.Pool;

  beforeAll(async () => {
    app = await createTestApp();
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
  });

  afterAll(async () => {
    await pool.end();
    await app.close();
  });

  async function projectWithRetention(days: number) {
    const setup = await setupProjectWithKey(app);
    await request(app.getHttpServer())
      .patch(`/v1/projects/${setup.projectId}`)
      .set(bearer(setup.owner.accessToken))
      .send({ retentionDays: days })
      .expect(200);
    return setup.projectId;
  }

  /** A trace with a parent and a child span, usage, an error and an evaluation. */
  async function seedTrace(projectId: string, externalId: string, startedAt: string) {
    const {
      rows: [trace],
    } = await pool.query<{ id: string }>(
      `INSERT INTO traces (project_id, external_id, name, environment, status, started_at)
       VALUES ($1, $2, 'support', 'production', 'error', $3) RETURNING id`,
      [projectId, externalId, startedAt],
    );
    const {
      rows: [parent],
    } = await pool.query<{ id: string }>(
      `INSERT INTO spans (trace_id, project_id, external_id, name, kind, started_at)
       VALUES ($1, $2, 'root', 'agent', 'custom', $3) RETURNING id`,
      [trace!.id, projectId, startedAt],
    );
    const {
      rows: [child],
    } = await pool.query<{ id: string }>(
      `INSERT INTO spans (trace_id, project_id, parent_span_id, external_id, name, kind, model, started_at)
       VALUES ($1, $2, $3, 'llm', 'answer', 'llm', 'm', $4) RETURNING id`,
      [trace!.id, projectId, parent!.id, startedAt],
    );
    await pool.query(
      `INSERT INTO token_usage (span_id, project_id, input_tokens, output_tokens, total_tokens, recorded_at)
       VALUES ($1, $2, 10, 5, 15, $3)`,
      [child!.id, projectId, startedAt],
    );
    await pool.query(
      `INSERT INTO errors (project_id, trace_id, span_id, type, message, occurred_at)
       VALUES ($1, $2, $3, 'timeout', 'slow', $4)`,
      [projectId, trace!.id, child!.id, startedAt],
    );
    await pool.query(
      `INSERT INTO evaluations (project_id, trace_id, criterion, kind, score, source)
       VALUES ($1, $2, 'user_feedback', 'thumbs', 1, 'api')`,
      [projectId, trace!.id],
    );
  }

  async function counts(projectId: string) {
    const { rows } = await pool.query<Record<string, string>>(
      `SELECT
         (SELECT count(*) FROM traces WHERE project_id = $1) AS traces,
         (SELECT count(*) FROM spans WHERE project_id = $1) AS spans,
         (SELECT count(*) FROM token_usage WHERE project_id = $1) AS usage,
         (SELECT count(*) FROM errors WHERE project_id = $1) AS errors,
         (SELECT count(*) FROM evaluations WHERE project_id = $1) AS evaluations,
         (SELECT count(*) FROM ingestion_failures WHERE project_id = $1) AS failures`,
      [projectId],
    );
    return Object.fromEntries(Object.entries(rows[0]!).map(([k, v]) => [k, Number(v)]));
  }

  it('deletes whole traces older than the project retention, in batches, and keeps the rest', async () => {
    const shortLived = await projectWithRetention(7);
    const longLived = await projectWithRetention(30);

    for (let i = 0; i < 5; i += 1) await seedTrace(shortLived, `old-${i}`, daysAgo(8 + i));
    await seedTrace(shortLived, 'edge-kept', daysAgo(6.9));
    await seedTrace(shortLived, 'fresh', daysAgo(1));
    await seedTrace(longLived, 'ten-days', daysAgo(10));
    await pool.query(
      `INSERT INTO ingestion_failures (project_id, reason, created_at) VALUES
         ($1, 'old', $2), ($1, 'recent', $3)`,
      [shortLived, daysAgo(9), daysAgo(2)],
    );

    const db = drizzle(pool);
    const first = await purgeExpiredTelemetry(db, { now: NOW, batchSize: 2 });
    const shortResult = first.projects.find((project) => project.projectId === shortLived);
    expect(shortResult).toMatchObject({ retentionDays: 7, traces: 5, ingestionFailures: 1 });
    expect(first.projects.some((project) => project.projectId === longLived)).toBe(false);

    expect(await counts(shortLived)).toEqual({
      traces: 2,
      spans: 4,
      usage: 2,
      errors: 2,
      evaluations: 2,
      failures: 1,
    });
    expect((await counts(longLived)).traces).toBe(1);

    const { rows } = await pool.query<{ external_id: string }>(
      'SELECT external_id FROM traces WHERE project_id = $1 ORDER BY external_id',
      [shortLived],
    );
    expect(rows.map((row) => row.external_id)).toEqual(['edge-kept', 'fresh']);

    // Idempotent: a second run has nothing left to delete for these projects.
    const second = await purgeExpiredTelemetry(db, { now: NOW, projectId: shortLived });
    expect(second).toMatchObject({ traces: 0, ingestionFailures: 0, projects: [] });
  });

  it('applies to archived projects and can be scoped to one project', async () => {
    const archived = await projectWithRetention(3);
    const untouched = await projectWithRetention(3);
    await seedTrace(archived, 'old', daysAgo(5));
    await seedTrace(untouched, 'old', daysAgo(5));
    await pool.query('UPDATE projects SET archived_at = now() WHERE id = $1', [archived]);

    const result = await purgeExpiredTelemetry(drizzle(pool), { now: NOW, projectId: archived });
    expect(result.traces).toBe(1);
    expect((await counts(archived)).traces).toBe(0);
    expect((await counts(untouched)).traces).toBe(1);
  });

  it('removes orphan dead-letter rows after the default window', async () => {
    await pool.query(
      `INSERT INTO ingestion_failures (project_id, reason, created_at) VALUES
         (NULL, 'orphan-old', $1), (NULL, 'orphan-recent', $2)`,
      [daysAgo(31), daysAgo(29)],
    );
    await purgeExpiredTelemetry(drizzle(pool), { now: NOW });
    const { rows } = await pool.query<{ reason: string }>(
      `SELECT reason FROM ingestion_failures WHERE project_id IS NULL AND reason LIKE 'orphan-%'`,
    );
    expect(rows.map((row) => row.reason)).toEqual(['orphan-recent']);
  });

  it('rejects an invalid batch size', async () => {
    await expect(purgeExpiredTelemetry(drizzle(pool), { batchSize: 0 })).rejects.toThrow(
      /batchSize/,
    );
  });

  it('exposes a runnable job through the scheduler', async () => {
    const result = await app.get(RetentionScheduler).run();
    expect(result).toEqual(
      expect.objectContaining({ traces: expect.any(Number), projects: expect.any(Array) }),
    );
  });
});
