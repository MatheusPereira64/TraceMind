import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { bearer, createTestApp, registerUser, uniqueEmail } from './test-app.js';

describe('Auth (e2e)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('registers a user, creates an owned organization and sets an httpOnly session cookie', async () => {
    const email = uniqueEmail('register');
    const response = await request(app.getHttpServer())
      .post('/v1/auth/register')
      .send({
        name: 'Ana',
        email: email.toUpperCase(),
        password: 'a-very-strong-password',
        organizationName: 'Ana Labs',
      })
      .expect(201);

    expect(response.body.user.email).toBe(email);
    expect(response.body.user).not.toHaveProperty('passwordHash');
    expect(response.body.organizations).toEqual([
      expect.objectContaining({
        name: 'Ana Labs',
        role: 'owner',
        slug: expect.stringMatching(/^ana-labs/),
      }),
    ]);
    const cookie = String(response.headers['set-cookie']);
    expect(cookie).toMatch(/tm_session=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
  });

  it('rejects duplicate emails with 409, regardless of case', async () => {
    const session = await registerUser(app);
    await request(app.getHttpServer())
      .post('/v1/auth/register')
      .send({
        name: 'Dup',
        email: session.user.email.toUpperCase(),
        password: 'another-strong-password',
        organizationName: 'Dup Org',
      })
      .expect(409);
  });

  it('returns field-level validation issues', async () => {
    const response = await request(app.getHttpServer())
      .post('/v1/auth/register')
      .send({ name: '', email: 'not-an-email', password: 'short', organizationName: 'x' })
      .expect(400);
    const paths = (response.body.issues as Array<{ path: string }>).map((issue) => issue.path);
    expect(paths).toEqual(
      expect.arrayContaining(['name', 'email', 'password', 'organizationName']),
    );
  });

  it('logs in with valid credentials and rejects invalid ones with the same message', async () => {
    const session = await registerUser(app);
    await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ email: session.user.email, password: session.password })
      .expect(200);

    const wrongPassword = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ email: session.user.email, password: 'wrong-password-123' })
      .expect(401);
    const unknownUser = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ email: uniqueEmail('ghost'), password: 'wrong-password-123' })
      .expect(401);
    expect(wrongPassword.body.message).toBe(unknownUser.body.message);
  });

  it('authenticates /me with a bearer token or the session cookie', async () => {
    const session = await registerUser(app);

    const viaBearer = await request(app.getHttpServer())
      .get('/v1/auth/me')
      .set(bearer(session.accessToken))
      .expect(200);
    expect(viaBearer.body.user.id).toBe(session.user.id);

    await request(app.getHttpServer())
      .get('/v1/auth/me')
      .set('Cookie', `tm_session=${session.accessToken}`)
      .expect(200);
  });

  it('rejects missing, malformed and tampered tokens', async () => {
    const session = await registerUser(app);
    await request(app.getHttpServer()).get('/v1/auth/me').expect(401);
    await request(app.getHttpServer()).get('/v1/auth/me').set(bearer('not-a-jwt')).expect(401);

    const [header, payload, signature] = session.accessToken.split('.');
    const tampered = `${header}.${payload}.${signature?.slice(0, -2)}xx`;
    await request(app.getHttpServer()).get('/v1/auth/me').set(bearer(tampered)).expect(401);
  });

  it('clears the session cookie on logout', async () => {
    const response = await request(app.getHttpServer()).post('/v1/auth/logout').expect(204);
    expect(String(response.headers['set-cookie'])).toMatch(/tm_session=;/);
  });

  it('echoes a well-formed request id and generates one otherwise', async () => {
    const echoed = await request(app.getHttpServer()).get('/health').set('X-Request-Id', 'abc-123');
    expect(echoed.headers['x-request-id']).toBe('abc-123');
    const generated = await request(app.getHttpServer())
      .get('/health')
      .set('X-Request-Id', 'bad id!');
    expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('reports readiness of database and redis', async () => {
    const response = await request(app.getHttpServer()).get('/health/ready').expect(200);
    expect(response.body.checks).toEqual({ database: 'up', redis: 'up' });
  });
});
