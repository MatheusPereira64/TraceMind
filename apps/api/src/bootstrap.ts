import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import type { Express } from 'express';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import type { Env } from './config/env.js';

/** Maximum accepted JSON body. Telemetry batches can be large but must stay bounded. */
export const JSON_BODY_LIMIT = '5mb';

/**
 * HTTP-level configuration shared by the server entrypoint and the integration tests, so tests
 * exercise the same middleware stack as production. The app must be created with
 * `{ bodyParser: false }` so the parser limit below is the only one.
 */
export function configureApp(app: NestExpressApplication, env: Env): void {
  app.useLogger(app.get(Logger));
  app.useBodyParser('json', { limit: JSON_BODY_LIMIT });

  const express = app.getHttpAdapter().getInstance() as Express;
  express.disable('x-powered-by');
  if (env.TRUST_PROXY) express.set('trust proxy', 1);

  app.use(helmet());
  app.use(cookieParser());
  app.enableCors({
    origin: env.WEB_ORIGIN,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'X-TraceMind-Key'],
    exposedHeaders: ['X-Request-Id'],
    maxAge: 600,
  });
  app.enableShutdownHooks();
}
