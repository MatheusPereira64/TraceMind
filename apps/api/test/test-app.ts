import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { SessionDto } from '@tracemind/shared';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { SCRYPT_PARAMS } from '../src/auth/password.service.js';
import { configureApp } from '../src/bootstrap.js';
import { ENV, type Env } from '../src/config/env.js';

export async function createTestApp(): Promise<NestExpressApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(SCRYPT_PARAMS)
    // Cheap parameters keep the suite fast; production parameters are covered by unit tests.
    .useValue({ N: 2 ** 10, r: 8, p: 1 })
    .compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
  configureApp(app, app.get<Env>(ENV));
  await app.init();
  return app;
}

export function uniqueEmail(label = 'user'): string {
  return `${label}-${randomUUID().slice(0, 8)}@example.com`;
}

export async function registerUser(
  app: NestExpressApplication,
  overrides: Partial<{
    name: string;
    email: string;
    password: string;
    organizationName: string;
  }> = {},
): Promise<SessionDto & { password: string }> {
  const password = overrides.password ?? 'a-very-strong-password';
  const response = await request(app.getHttpServer())
    .post('/v1/auth/register')
    .send({
      name: overrides.name ?? 'Test User',
      email: overrides.email ?? uniqueEmail(),
      password,
      organizationName: overrides.organizationName ?? 'Test Org',
    })
    .expect(201);
  return { ...(response.body as SessionDto), password };
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
