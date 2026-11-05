import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import { Public } from '../auth/decorators.js';
import { PG_POOL } from '../database/database.module.js';
import { REDIS } from '../redis/redis.module.js';

type DependencyStatus = 'up' | 'down';

const CHECK_TIMEOUT_MS = 2_000;

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), CHECK_TIMEOUT_MS).unref(),
    ),
  ]);
}

@Public()
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** Liveness: the process is up and serving HTTP. */
  @Get()
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Readiness: dependencies are reachable. Returns 503 when any is down. */
  @Get('ready')
  async ready(): Promise<{ status: 'ok'; checks: Record<string, DependencyStatus> }> {
    const [database, redis] = await Promise.all([
      withTimeout(this.pool.query('SELECT 1')).then(
        (): DependencyStatus => 'up',
        (): DependencyStatus => 'down',
      ),
      withTimeout(this.redis.ping()).then(
        (): DependencyStatus => 'up',
        (): DependencyStatus => 'down',
      ),
    ]);
    const checks = { database, redis };
    if (database === 'down' || redis === 'down') {
      throw new ServiceUnavailableException({ message: 'Dependencies unavailable', checks });
    }
    return { status: 'ok', checks };
  }
}
