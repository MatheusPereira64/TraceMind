import type { Environment, IngestEvent } from '@tracemind/shared';

/** Payload of one queued ingestion job (one accepted batch, already validated and redacted). */
export interface IngestionJobData {
  projectId: string;
  /** Default environment from the API key, used when an event does not set one. */
  environment: Environment;
  events: IngestEvent[];
  /** ISO timestamp; default start time for events that omit it. */
  receivedAt: string;
  /** Marks simulated telemetry (demo seeding). */
  simulated?: boolean;
}

export const INGESTION_QUEUE = 'tracemind-ingestion';

/** Thrown when an event references something that has not arrived yet; the job is retried. */
export class RetryableIngestionError extends Error {
  override readonly name = 'RetryableIngestionError';
}
