import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { Queue, UnrecoverableError, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { ENV, type Env } from '../config/env.js';
import { DATABASE, type Database } from '../database/database.module.js';
import { ingestionFailures } from '../database/schema.js';
import { IngestionProcessor } from './ingestion.processor.js';
import {
  INGESTION_QUEUE,
  RetryableIngestionError,
  type IngestionJobData,
} from './ingestion.types.js';

const ATTEMPTS = 6;
/** Keep the dead-letter payload bounded even for 5 MB batches. */
const MAX_DEAD_LETTER_BYTES = 512 * 1024;

/**
 * Owns the BullMQ queue (producer side, used by the HTTP handler) and, unless disabled, a worker in
 * the same process. Jobs are retried with exponential backoff for transient failures;
 * after the last attempt the batch is written to `ingestion_failures` so it is never lost silently.
 */
@Injectable()
export class IngestionQueue implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(IngestionQueue.name);
  private readonly queueConnection: Redis;
  private workerConnection: Redis | undefined;
  readonly queue: Queue<IngestionJobData>;
  private worker: Worker<IngestionJobData> | undefined;

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(DATABASE) private readonly db: Database,
    private readonly processor: IngestionProcessor,
  ) {
    this.queueConnection = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
    });
    this.queue = new Queue<IngestionJobData>(INGESTION_QUEUE, {
      connection: this.queueConnection,
      defaultJobOptions: {
        attempts: ATTEMPTS,
        backoff: { type: 'exponential', delay: env.INGESTION_RETRY_DELAY_MS },
        removeOnComplete: { count: 1_000 },
        removeOnFail: { count: 5_000 },
      },
    });
  }

  onModuleInit(): void {
    if (!this.env.INGESTION_WORKER_ENABLED) {
      this.logger.log('Ingestion worker disabled in this process');
      return;
    }
    // Workers use blocking commands and require maxRetriesPerRequest: null.
    this.workerConnection = new Redis(this.env.REDIS_URL, { maxRetriesPerRequest: null });
    this.worker = new Worker<IngestionJobData>(INGESTION_QUEUE, (job) => this.handle(job), {
      connection: this.workerConnection,
      concurrency: this.env.INGESTION_CONCURRENCY,
    });
    this.worker.on('failed', (job, error) => {
      if (job) void this.onFailed(job, error);
    });
    this.worker.on('error', (error) => this.logger.error({ err: error }, 'Ingestion worker error'));
  }

  async enqueue(data: IngestionJobData): Promise<string> {
    const job = await this.queue.add('batch', data);
    return job.id!;
  }

  /** Waiting + delayed batches; used for back-pressure. */
  async backlog(): Promise<number> {
    const counts = await this.queue.getJobCounts('waiting', 'delayed', 'prioritized');
    return Object.values(counts).reduce((sum, value) => sum + value, 0);
  }

  async onApplicationShutdown(): Promise<void> {
    // Let in-flight jobs finish before closing connections.
    await this.worker?.close();
    await this.queue.close();
    for (const connection of [this.workerConnection, this.queueConnection]) {
      if (connection && connection.status !== 'end')
        await connection.quit().catch(() => connection.disconnect());
    }
  }

  private async handle(job: Job<IngestionJobData>) {
    try {
      return await this.processor.process(job.data);
    } catch (error) {
      if (error instanceof RetryableIngestionError) throw error;
      if (isPermanentDataError(error)) {
        // Retrying cannot fix invalid data (e.g. value out of range): fail fast to the dead letter.
        throw new UnrecoverableError(errorMessage(error));
      }
      throw error;
    }
  }

  private async onFailed(job: Job<IngestionJobData>, error: Error): Promise<void> {
    const exhausted =
      error instanceof UnrecoverableError || job.attemptsMade >= (job.opts.attempts ?? 1);
    if (!exhausted) {
      this.logger.warn(
        { jobId: job.id, attempt: job.attemptsMade, err: error },
        'Ingestion batch failed, will retry',
      );
      return;
    }
    this.logger.error({ jobId: job.id, err: error }, 'Ingestion batch moved to dead letter');
    try {
      await this.db.insert(ingestionFailures).values({
        projectId: job.data.projectId,
        reason: `processing: ${errorMessage(error)}`.slice(0, 1_000),
        payload: boundedPayload(job.data),
      });
    } catch (dlqError) {
      this.logger.error({ jobId: job.id, err: dlqError }, 'Failed to record ingestion failure');
    }
  }
}

/** PostgreSQL data exceptions (class 22) and check violations (23514) will not succeed on retry. */
function isPermanentDataError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 4; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && (code.startsWith('22') || code === '23514')) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function errorMessage(error: unknown): string {
  const cause = (error as { cause?: { message?: string } }).cause;
  return cause?.message ?? (error instanceof Error ? error.message : String(error));
}

function boundedPayload(data: IngestionJobData): unknown {
  const serialized = JSON.stringify(data.events);
  if (serialized.length <= MAX_DEAD_LETTER_BYTES)
    return { events: data.events, receivedAt: data.receivedAt };
  return {
    truncated: true,
    eventCount: data.events.length,
    eventIds: data.events.map((event) => ('id' in event ? event.id : null)).slice(0, 1_000),
    receivedAt: data.receivedAt,
  };
}
