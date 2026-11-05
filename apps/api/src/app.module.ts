import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiKeysModule } from './api-keys/api-keys.module.js';
import { AuthModule } from './auth/auth.module.js';
import { AUTH_RATE_LIMITED, INGEST_RATE_LIMITED } from './auth/decorators.js';
import { HttpExceptionFilter } from './common/http-exception.filter.js';
import { ConfigModule } from './config/config.module.js';
import { ENV, type Env } from './config/env.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthController } from './health/health.controller.js';
import { IngestionModule } from './ingestion/ingestion.module.js';
import { OrganizationsModule } from './organizations/organizations.module.js';
import { ProjectsModule } from './projects/projects.module.js';
import { RedisModule } from './redis/redis.module.js';

const MINUTE_MS = 60_000;
const REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRootAsync({
      inject: [ENV],
      useFactory: (env: Env) => ({
        pinoHttp: {
          level: env.LOG_LEVEL,
          // Propagate a caller-provided request id when it is well-formed, otherwise mint one.
          genReqId: (request: IncomingMessage, response: ServerResponse) => {
            const header = request.headers['x-request-id'];
            const id =
              typeof header === 'string' && REQUEST_ID.test(header) ? header : randomUUID();
            response.setHeader('X-Request-Id', id);
            return id;
          },
          customProps: () => ({ service: 'tracemind-api' }),
          redact: {
            paths: [
              'req.headers.authorization',
              'req.headers.cookie',
              'req.headers["x-tracemind-key"]',
              'res.headers["set-cookie"]',
            ],
            censor: '[REDACTED]',
          },
          autoLogging: {
            ignore: (request: IncomingMessage) => request.url?.startsWith('/health') ?? false,
          },
          ...(env.NODE_ENV === 'development'
            ? { transport: { target: 'pino-pretty', options: { singleLine: true } } }
            : {}),
        },
      }),
    }),
    ThrottlerModule.forRootAsync({
      inject: [ENV],
      useFactory: (env: Env) => ({
        throttlers: [
          { name: 'default', ttl: MINUTE_MS, limit: env.RATE_LIMIT_PER_MINUTE },
          {
            name: 'auth',
            ttl: MINUTE_MS,
            limit: env.AUTH_RATE_LIMIT_PER_MINUTE,
            skipIf: (context) =>
              Reflect.getMetadata(AUTH_RATE_LIMITED, context.getHandler()) !== true,
          },
          {
            // Keyed by API key rather than IP: many services may share one egress IP.
            name: 'ingest',
            ttl: MINUTE_MS,
            limit: env.INGEST_RATE_LIMIT_PER_MINUTE,
            skipIf: (context) =>
              Reflect.getMetadata(INGEST_RATE_LIMITED, context.getClass()) !== true,
            getTracker: (request: Record<string, unknown>) => {
              const headers = request.headers as Record<string, string | undefined>;
              const key =
                headers.authorization?.replace(/^Bearer\s+/i, '') ??
                headers['x-tracemind-key'] ??
                '';
              return key
                ? `key:${createHash('sha256').update(key).digest('hex').slice(0, 24)}`
                : `ip:${String(request.ip)}`;
            },
          },
        ],
      }),
    }),
    DatabaseModule,
    RedisModule,
    OrganizationsModule,
    AuthModule,
    ProjectsModule,
    ApiKeysModule,
    IngestionModule,
  ],
  controllers: [HealthController],
  providers: [
    // Order matters: throttle before authenticating so unauthenticated floods are cheap to reject.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
export class AppModule {}
