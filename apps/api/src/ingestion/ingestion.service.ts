import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import {
  DEFAULT_REDACTION_SETTINGS,
  ingestEventSchema,
  type IngestBatchResponse,
  type IngestEvent,
  type IngestRejection,
  type RedactionSettings,
} from '@tracemind/shared';
import { eq } from 'drizzle-orm';
import type { ApiKeyPrincipal } from '../auth/auth.types.js';
import { ENV, type Env } from '../config/env.js';
import { DATABASE, type Database } from '../database/database.module.js';
import { ingestionFailures, projects } from '../database/schema.js';
import { IngestionQueue } from './ingestion.queue.js';
import { Redactor } from './redaction.js';

const SETTINGS_TTL_MS = 30_000;
/** Rejected events stored per batch for inspection; the response always lists all of them. */
const MAX_STORED_REJECTIONS = 20;

/**
 * Request-path half of ingestion: validates each event independently, redacts accepted events and
 * enqueues them. Persistence happens in the worker (IngestionProcessor).
 */
@Injectable()
export class IngestionService {
  private readonly logger = new Logger(IngestionService.name);
  private readonly settingsCache = new Map<
    string,
    { settings: RedactionSettings; expiresAt: number }
  >();
  private readonly fallbackRedactor = new Redactor(DEFAULT_REDACTION_SETTINGS);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    private readonly queue: IngestionQueue,
  ) {}

  async ingest(
    principal: ApiKeyPrincipal,
    rawEvents: unknown[],
    options: { simulated?: boolean } = {},
  ): Promise<IngestBatchResponse> {
    const accepted: IngestEvent[] = [];
    const rejected: IngestRejection[] = [];

    rawEvents.forEach((raw, index) => {
      const result = ingestEventSchema.safeParse(raw);
      if (result.success) {
        accepted.push(result.data);
      } else {
        const id = (raw as { id?: unknown } | null)?.id;
        rejected.push({
          index,
          ...(typeof id === 'string' ? { eventId: id.slice(0, 128) } : {}),
          issues: result.error.issues.map((issue) => ({
            path: issue.path.map(String).join('.'),
            message: issue.message,
          })),
        });
      }
    });

    if (rejected.length > 0) await this.recordRejections(principal.projectId, rawEvents, rejected);

    if (accepted.length === 0) return { batchId: null, accepted: 0, rejected };

    if ((await this.queue.backlog()) >= this.env.INGESTION_MAX_QUEUED_BATCHES) {
      throw new ServiceUnavailableException('Ingestion is temporarily overloaded, retry later');
    }

    const redactor = new Redactor(await this.redactionSettings(principal.projectId));
    const { value: events } = redactor.redact(accepted);

    const batchId = await this.queue.enqueue({
      projectId: principal.projectId,
      environment: principal.environment,
      events,
      receivedAt: new Date().toISOString(),
      ...(options.simulated ? { simulated: true } : {}),
    });

    return { batchId, accepted: accepted.length, rejected };
  }

  private async redactionSettings(projectId: string): Promise<RedactionSettings> {
    const cached = this.settingsCache.get(projectId);
    if (cached && cached.expiresAt > Date.now()) return cached.settings;
    const project = await this.db.query.projects.findFirst({
      columns: { redaction: true },
      where: eq(projects.id, projectId),
    });
    const settings = project?.redaction ?? DEFAULT_REDACTION_SETTINGS;
    this.settingsCache.set(projectId, { settings, expiresAt: Date.now() + SETTINGS_TTL_MS });
    return settings;
  }

  /** Invalid events are kept (redacted) so developers can see why they were dropped. */
  private async recordRejections(
    projectId: string,
    rawEvents: unknown[],
    rejected: IngestRejection[],
  ): Promise<void> {
    try {
      await this.db.insert(ingestionFailures).values(
        rejected.slice(0, MAX_STORED_REJECTIONS).map((rejection) => ({
          projectId,
          reason: `validation: ${rejection.issues
            .map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message))
            .join('; ')}`.slice(0, 1_000),
          payload: this.fallbackRedactor.redact(rawEvents[rejection.index] ?? null).value,
        })),
      );
    } catch (error) {
      // Bookkeeping must never fail the request: the response already reports the rejections.
      this.logger.warn({ err: error, projectId }, 'Failed to record rejected events');
    }
  }

  invalidateSettings(projectId: string): void {
    this.settingsCache.delete(projectId);
  }
}
