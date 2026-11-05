import type { NestExpressApplication } from '@nestjs/platform-express';
import type { CreatedApiKeyDto, ProjectDto } from '@tracemind/shared';
import pg from 'pg';
import request from 'supertest';
import { bearer, createTestApp, registerUser } from './test-app.js';

describe('Organizations, projects and API keys (e2e)', () => {
  let app: NestExpressApplication;
  let pool: pg.Pool;

  beforeAll(async () => {
    app = await createTestApp();
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  });

  afterAll(async () => {
    await pool.end();
    await app.close();
  });

  async function setupOwnerWithProject() {
    const owner = await registerUser(app, { organizationName: 'Acme AI' });
    const organizationId = owner.organizations[0]!.id;
    const project = (
      await request(app.getHttpServer())
        .post(`/v1/organizations/${organizationId}/projects`)
        .set(bearer(owner.accessToken))
        .send({ name: 'Support Bot', description: 'Customer support assistant' })
        .expect(201)
    ).body as ProjectDto;
    return { owner, organizationId, project };
  }

  describe('organizations', () => {
    it('creates additional organizations and lists only the caller memberships', async () => {
      const user = await registerUser(app, { organizationName: 'First' });
      const other = await registerUser(app, { organizationName: 'Someone Else' });

      await request(app.getHttpServer())
        .post('/v1/organizations')
        .set(bearer(user.accessToken))
        .send({ name: 'Second Org' })
        .expect(201);

      const list = await request(app.getHttpServer())
        .get('/v1/organizations')
        .set(bearer(user.accessToken))
        .expect(200);
      const names = (list.body as Array<{ name: string }>).map((org) => org.name);
      expect(names).toEqual(['First', 'Second Org']);
      expect(names).not.toContain(other.organizations[0]!.name);
    });

    it('suffixes derived slugs on collision but rejects a taken explicit slug', async () => {
      const user = await registerUser(app, { organizationName: 'Collision Co' });
      const second = await request(app.getHttpServer())
        .post('/v1/organizations')
        .set(bearer(user.accessToken))
        .send({ name: 'Collision Co' })
        .expect(201);
      expect(second.body.slug).toMatch(/^collision-co-[0-9a-f]{6}$/);

      await request(app.getHttpServer())
        .post('/v1/organizations')
        .set(bearer(user.accessToken))
        .send({ name: 'Another', slug: user.organizations[0]!.slug })
        .expect(409);
    });
  });

  describe('projects', () => {
    it('creates, reads, updates and archives a project', async () => {
      const { owner, organizationId, project } = await setupOwnerWithProject();
      expect(project).toMatchObject({
        organizationId,
        slug: 'support-bot',
        retentionDays: 30,
        isDemo: false,
      });

      await request(app.getHttpServer())
        .patch(`/v1/projects/${project.id}`)
        .set(bearer(owner.accessToken))
        .send({ retentionDays: 90, description: null })
        .expect(200)
        .expect((response) => {
          expect(response.body.retentionDays).toBe(90);
          expect(response.body.description).toBeNull();
        });

      await request(app.getHttpServer())
        .delete(`/v1/projects/${project.id}`)
        .set(bearer(owner.accessToken))
        .expect(200)
        .expect((response) => expect(response.body.archivedAt).not.toBeNull());

      const active = await request(app.getHttpServer())
        .get(`/v1/organizations/${organizationId}/projects`)
        .set(bearer(owner.accessToken))
        .expect(200);
      expect(active.body).toHaveLength(0);

      const all = await request(app.getHttpServer())
        .get(`/v1/organizations/${organizationId}/projects?includeArchived=true`)
        .set(bearer(owner.accessToken))
        .expect(200);
      expect(all.body).toHaveLength(1);
    });

    it('rejects duplicate explicit slugs inside the same organization', async () => {
      const { owner, organizationId } = await setupOwnerWithProject();
      await request(app.getHttpServer())
        .post(`/v1/organizations/${organizationId}/projects`)
        .set(bearer(owner.accessToken))
        .send({ name: 'Other', slug: 'support-bot' })
        .expect(409);
    });

    it('isolates tenants: outsiders get 404 for every project route', async () => {
      const { organizationId, project } = await setupOwnerWithProject();
      const outsider = await registerUser(app);
      const server = app.getHttpServer();
      const auth = bearer(outsider.accessToken);

      await request(server)
        .get(`/v1/organizations/${organizationId}/projects`)
        .set(auth)
        .expect(404);
      await request(server)
        .post(`/v1/organizations/${organizationId}/projects`)
        .set(auth)
        .send({ name: 'Hijack' })
        .expect(404);
      await request(server).get(`/v1/projects/${project.id}`).set(auth).expect(404);
      await request(server)
        .patch(`/v1/projects/${project.id}`)
        .set(auth)
        .send({ name: 'Hijack' })
        .expect(404);
      await request(server).delete(`/v1/projects/${project.id}`).set(auth).expect(404);
      await request(server).get(`/v1/projects/${project.id}/api-keys`).set(auth).expect(404);
      await request(server)
        .post(`/v1/projects/${project.id}/api-keys`)
        .set(auth)
        .send({ name: 'x' })
        .expect(404);
    });

    it('enforces roles: viewers can read but not modify', async () => {
      const { organizationId, project } = await setupOwnerWithProject();
      const viewer = await registerUser(app);
      await pool.query(
        `INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'viewer')`,
        [organizationId, viewer.user.id],
      );
      const auth = bearer(viewer.accessToken);

      await request(app.getHttpServer()).get(`/v1/projects/${project.id}`).set(auth).expect(200);
      await request(app.getHttpServer())
        .get(`/v1/projects/${project.id}/api-keys`)
        .set(auth)
        .expect(200);
      await request(app.getHttpServer())
        .patch(`/v1/projects/${project.id}`)
        .set(auth)
        .send({ name: 'Renamed' })
        .expect(403);
      await request(app.getHttpServer())
        .post(`/v1/projects/${project.id}/api-keys`)
        .set(auth)
        .send({ name: 'x' })
        .expect(403);
      await request(app.getHttpServer())
        .post(`/v1/organizations/${organizationId}/projects`)
        .set(auth)
        .send({ name: 'New' })
        .expect(403);
    });

    it('validates path parameters', async () => {
      const user = await registerUser(app);
      await request(app.getHttpServer())
        .get('/v1/projects/not-a-uuid')
        .set(bearer(user.accessToken))
        .expect(400);
    });
  });

  describe('API keys', () => {
    async function createKey(
      token: string,
      projectId: string,
      body: Record<string, unknown> = { name: 'ci' },
    ) {
      return (
        await request(app.getHttpServer())
          .post(`/v1/projects/${projectId}/api-keys`)
          .set(bearer(token))
          .send(body)
          .expect(201)
      ).body as CreatedApiKeyDto;
    }

    it('returns the plaintext key once and stores only its hash', async () => {
      const { owner, project } = await setupOwnerWithProject();
      const created = await createKey(owner.accessToken, project.id, {
        name: 'prod',
        environment: 'production',
      });

      expect(created.key).toMatch(/^tm_prod_/);
      expect(created.key.startsWith(created.prefix)).toBe(true);

      const { rows } = await pool.query<{ key_hash: string }>(
        'SELECT key_hash FROM api_keys WHERE id = $1',
        [created.id],
      );
      expect(rows[0]!.key_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(rows[0]!.key_hash).not.toContain(created.key);

      const list = await request(app.getHttpServer())
        .get(`/v1/projects/${project.id}/api-keys`)
        .set(bearer(owner.accessToken))
        .expect(200);
      expect(list.body).toHaveLength(1);
      expect(list.body[0]).not.toHaveProperty('key');
      expect(list.body[0]).not.toHaveProperty('keyHash');
    });

    it('authenticates telemetry clients and records last use', async () => {
      const { owner, organizationId, project } = await setupOwnerWithProject();
      const created = await createKey(owner.accessToken, project.id, {
        name: 'stg',
        environment: 'staging',
      });

      const viaBearer = await request(app.getHttpServer())
        .get('/v1/ingest/whoami')
        .set(bearer(created.key))
        .expect(200);
      expect(viaBearer.body).toEqual({
        projectId: project.id,
        organizationId,
        environment: 'staging',
      });

      await request(app.getHttpServer())
        .get('/v1/ingest/whoami')
        .set('X-TraceMind-Key', created.key)
        .expect(200);

      await vi.waitFor(async () => {
        const { rows } = await pool.query('SELECT last_used_at FROM api_keys WHERE id = $1', [
          created.id,
        ]);
        expect(rows[0].last_used_at).not.toBeNull();
      });
    });

    it('rejects unknown, revoked and expired keys', async () => {
      const { owner, project } = await setupOwnerWithProject();
      const server = app.getHttpServer();

      await request(server).get('/v1/ingest/whoami').expect(401);
      await request(server)
        .get('/v1/ingest/whoami')
        .set(bearer(`tm_dev_${'a'.repeat(32)}`))
        .expect(401);

      const revoked = await createKey(owner.accessToken, project.id);
      await request(server)
        .delete(`/v1/projects/${project.id}/api-keys/${revoked.id}`)
        .set(bearer(owner.accessToken))
        .expect(200)
        .expect((response) => expect(response.body.revokedAt).not.toBeNull());
      await request(server).get('/v1/ingest/whoami').set(bearer(revoked.key)).expect(401);

      const expired = await createKey(owner.accessToken, project.id);
      await pool.query(
        `UPDATE api_keys SET expires_at = now() - interval '1 minute' WHERE id = $1`,
        [expired.id],
      );
      await request(server).get('/v1/ingest/whoami').set(bearer(expired.key)).expect(401);
    });

    it('stops accepting keys of archived projects', async () => {
      const { owner, project } = await setupOwnerWithProject();
      const created = await createKey(owner.accessToken, project.id);
      await request(app.getHttpServer())
        .delete(`/v1/projects/${project.id}`)
        .set(bearer(owner.accessToken))
        .expect(200);
      await request(app.getHttpServer())
        .get('/v1/ingest/whoami')
        .set(bearer(created.key))
        .expect(401);
    });

    it('does not let API keys reach dashboard endpoints', async () => {
      const { owner, project } = await setupOwnerWithProject();
      const created = await createKey(owner.accessToken, project.id);
      await request(app.getHttpServer())
        .get('/v1/organizations')
        .set(bearer(created.key))
        .expect(401);
    });

    it('cannot revoke a key through another project', async () => {
      const first = await setupOwnerWithProject();
      const created = await createKey(first.owner.accessToken, first.project.id);

      const other = (
        await request(app.getHttpServer())
          .post(`/v1/organizations/${first.organizationId}/projects`)
          .set(bearer(first.owner.accessToken))
          .send({ name: 'Other project' })
          .expect(201)
      ).body as ProjectDto;

      await request(app.getHttpServer())
        .delete(`/v1/projects/${other.id}/api-keys/${created.id}`)
        .set(bearer(first.owner.accessToken))
        .expect(404);
    });

    it('rejects an expiry in the past', async () => {
      const { owner, project } = await setupOwnerWithProject();
      await request(app.getHttpServer())
        .post(`/v1/projects/${project.id}/api-keys`)
        .set(bearer(owner.accessToken))
        .send({ name: 'old', expiresAt: '2020-01-01T00:00:00Z' })
        .expect(400);
    });
  });
});
