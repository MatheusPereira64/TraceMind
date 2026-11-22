import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { ENV, type Env } from '../config/env.js';
import { DATABASE, type Database } from '../database/database.module.js';
import { purgeExpiredTelemetry, type RetentionResult } from './retention.js';

export const RETENTION_QUEUE = 'tracemind-retention';
const SCHEDULER_ID = 'retention-daily';

/**
 * Runs the retention job on a cron schedule through a BullMQ job scheduler. The scheduler lives in
 * Redis and is upserted by id, so every API replica can register it and only one job is created
 * per tick; whichever replica's worker picks it up runs it (concurrency 1).
 */
@Injectable()
export class RetentionScheduler implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(RetentionScheduler.name);
  private queueConnection: Redis | undefined;
  private workerConnection: Redis | undefined;
  private queue: Queue | undefined;
  private worker: Worker | undefined;

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.register();
    } catch (error) {
      // Retention is housekeeping: a Redis hiccup at boot must not keep the API from starting.
      this.logger.error({ err: error }, 'Could not register the retention job');
    }
  }

  private async register(): Promise<void> {
    this.queueConnection = new Redis(this.env.REDIS_URL, { maxRetriesPerRequest: 2 });
    this.queue = new Queue(RETENTION_QUEUE, {
      connection: this.queueConnection,
      defaultJobOptions: { removeOnComplete: { count: 30 }, removeOnFail: { count: 30 } },
    });

    if (!this.env.RETENTION_ENABLED) {
      // Turning the flag off must also stop a schedule registered by an earlier deployment.
      await this.queue.removeJobScheduler(SCHEDULER_ID).catch(() => false);
      this.logger.log('Retention job disabled');
      return;
    }

    await this.queue.upsertJobScheduler(
      SCHEDULER_ID,
      { pattern: this.env.RETENTION_CRON, tz: 'UTC' },
      { name: 'purge' },
    );
    this.workerConnection = new Redis(this.env.REDIS_URL, { maxRetriesPerRequest: null });
    this.worker = new Worker(RETENTION_QUEUE, () => this.run(), {
      connection: this.workerConnection,
      concurrency: 1,
    });
    this.worker.on('failed', (_job, error) =>
      this.logger.error({ err: error }, 'Retention job failed'),
    );
    this.worker.on('error', (error) => this.logger.error({ err: error }, 'Retention worker error'));
    this.logger.log(`Retention job scheduled (${this.env.RETENTION_CRON} UTC)`);
  }

  async run(): Promise<RetentionResult> {
    const result = await purgeExpiredTelemetry(this.db, {
      batchSize: this.env.RETENTION_BATCH_SIZE,
    });
    this.logger.log(
      {
        traces: result.traces,
        ingestionFailures: result.ingestionFailures,
        projects: result.projects.length,
        durationMs: result.durationMs,
      },
      'Retention job completed',
    );
    return result;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
    for (const connection of [this.workerConnection, this.queueConnection]) {
      if (connection && connection.status !== 'end')
        await connection.quit().catch(() => connection.disconnect());
    }
  }
}
