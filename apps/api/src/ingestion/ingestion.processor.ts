import { Inject, Injectable } from '@nestjs/common';
import type { ErrorInfoInput, EvaluationEvent, SpanEvent, TraceEvent } from '@tracemind/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { DATABASE, type Database } from '../database/database.module.js';
import {
  evaluations,
  modelProviders,
  spans,
  telemetryErrors,
  tokenUsage,
  traces,
} from '../database/schema.js';
import { estimateCostUsd, formatReportedCost } from './cost.js';
import { RetryableIngestionError, type IngestionJobData } from './ingestion.types.js';
import { PricingService } from './pricing.service.js';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

const date = (iso: string | undefined): Date | undefined => (iso ? new Date(iso) : undefined);

/** Keeps only keys whose value is not undefined, so partial updates never clear stored fields. */
function defined<T extends Record<string, unknown>>(record: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

/**
 * Persists one batch atomically. Every write is an upsert keyed by the client id, so processing the
 * same batch twice (queue retries, SDK retries) converges to the same state.
 *
 * Ordering is not assumed: spans may arrive before their trace (a placeholder trace is created) or
 * before their parent (the parent link is resolved by external id once the parent exists).
 */
@Injectable()
export class IngestionProcessor {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly pricing: PricingService,
  ) {}

  async process(
    job: IngestionJobData,
  ): Promise<{ traces: number; spans: number; evaluations: number }> {
    const receivedAt = new Date(job.receivedAt);
    const traceEvents = job.events.filter((event): event is TraceEvent => event.type === 'trace');
    const spanEvents = job.events.filter((event): event is SpanEvent => event.type === 'span');
    const evaluationEvents = job.events.filter(
      (event): event is EvaluationEvent => event.type === 'evaluation',
    );

    return this.db.transaction(async (tx) => {
      const context = { tx, job, receivedAt, simulated: job.simulated ?? false };

      await this.ensureProviders(tx, spanEvents);

      const traceIds = new Map<string, string>();
      for (const event of traceEvents) {
        traceIds.set(event.id, await this.upsertTrace(context, event));
      }

      // Placeholder traces for spans/evaluations whose trace event has not arrived.
      const referenced = new Map<string, Date>();
      for (const event of [...spanEvents, ...evaluationEvents]) {
        if (traceIds.has(event.traceId)) continue;
        const start = event.type === 'span' ? (date(event.startTime) ?? receivedAt) : receivedAt;
        const current = referenced.get(event.traceId);
        if (!current || start < current) referenced.set(event.traceId, start);
      }
      for (const [externalId, startedAt] of referenced) {
        traceIds.set(externalId, await this.ensureTrace(context, externalId, startedAt));
      }

      for (const event of spanEvents) {
        await this.upsertSpan(context, traceIds.get(event.traceId)!, event);
      }

      const touchedTraceIds = [...new Set(traceIds.values())];
      if (touchedTraceIds.length > 0) {
        await this.resolveParents(tx, touchedTraceIds);
        await this.updateDurations(tx, touchedTraceIds);
      }

      for (const event of evaluationEvents) {
        await this.insertEvaluation(context, traceIds.get(event.traceId)!, event);
      }

      return {
        traces: traceEvents.length,
        spans: spanEvents.length,
        evaluations: evaluationEvents.length,
      };
    });
  }

  /* ------------------------------------------------------------------ traces */

  private async upsertTrace(
    context: { tx: Tx; job: IngestionJobData; receivedAt: Date; simulated: boolean },
    event: TraceEvent,
  ): Promise<string> {
    const { tx, job, receivedAt } = context;
    const endedAt = date(event.endTime);
    const derivedStatus = event.status ?? (event.error ? 'error' : endedAt ? 'success' : undefined);

    const provided = defined({
      name: event.name,
      environment: event.environment,
      endUserId: event.userId,
      sessionId: event.sessionId,
      tags: event.tags,
      metadata: event.metadata,
      input: event.input,
      output: event.output,
      startedAt: date(event.startTime),
      endedAt,
    });

    const [row] = await tx
      .insert(traces)
      .values({
        projectId: job.projectId,
        externalId: event.id,
        name: event.name ?? '(unnamed trace)',
        environment: event.environment ?? job.environment,
        status: derivedStatus ?? 'running',
        endUserId: event.userId,
        sessionId: event.sessionId,
        tags: event.tags ?? [],
        metadata: event.metadata ?? {},
        input: event.input,
        output: event.output,
        startedAt: date(event.startTime) ?? receivedAt,
        endedAt,
        isComplete: true,
        isSimulated: context.simulated,
      })
      .onConflictDoUpdate({
        target: [traces.projectId, traces.externalId],
        set: {
          ...provided,
          isComplete: true,
          // An explicit status wins; otherwise "ended" means success unless an error was recorded.
          ...(derivedStatus === undefined
            ? {}
            : event.status
              ? { status: event.status }
              : {
                  status: sql`CASE WHEN ${traces.status} = 'error' THEN 'error'::trace_status ELSE ${derivedStatus}::trace_status END`,
                }),
        },
      })
      .returning({ id: traces.id });

    const traceId = row!.id;
    if (event.error) {
      await this.upsertError(tx, {
        projectId: job.projectId,
        traceId,
        spanId: null,
        error: event.error,
        occurredAt: endedAt ?? receivedAt,
      });
    }
    return traceId;
  }

  private async ensureTrace(
    context: { tx: Tx; job: IngestionJobData; simulated: boolean },
    externalId: string,
    startedAt: Date,
  ): Promise<string> {
    const { tx, job } = context;
    const [row] = await tx
      .insert(traces)
      .values({
        projectId: job.projectId,
        externalId,
        name: '(pending trace)',
        environment: job.environment,
        startedAt,
        isComplete: false,
        isSimulated: context.simulated,
      })
      .onConflictDoUpdate({
        target: [traces.projectId, traces.externalId],
        // Placeholders widen to the earliest child; complete traces keep their own start time.
        set: {
          startedAt: sql`CASE WHEN ${traces.isComplete} THEN ${traces.startedAt} ELSE LEAST(${traces.startedAt}, excluded.started_at) END`,
        },
      })
      .returning({ id: traces.id });
    return row!.id;
  }

  /* ------------------------------------------------------------------- spans */

  private async upsertSpan(
    context: { tx: Tx; job: IngestionJobData; receivedAt: Date },
    traceId: string,
    event: SpanEvent,
  ): Promise<void> {
    const { tx, job, receivedAt } = context;
    const endedAt = date(event.endTime);
    const derivedStatus = event.status ?? (event.error ? 'error' : endedAt ? 'success' : undefined);
    const kind = event.kind ?? (event.model || event.usage ? 'llm' : undefined);

    const provided = defined({
      parentExternalId: event.parentId,
      name: event.name,
      kind,
      providerId: event.provider,
      model: event.model,
      input: event.input,
      output: event.output,
      modelParameters: event.modelParameters,
      metadata: event.metadata,
      startedAt: date(event.startTime),
      endedAt,
    });

    const [row] = await tx
      .insert(spans)
      .values({
        traceId,
        projectId: job.projectId,
        externalId: event.id,
        parentExternalId: event.parentId,
        name: event.name ?? '(unnamed span)',
        kind: kind ?? 'custom',
        status: derivedStatus ?? 'running',
        providerId: event.provider,
        model: event.model,
        input: event.input,
        output: event.output,
        modelParameters: event.modelParameters,
        metadata: event.metadata ?? {},
        startedAt: date(event.startTime) ?? receivedAt,
        endedAt,
      })
      .onConflictDoUpdate({
        target: [spans.traceId, spans.externalId],
        set: {
          ...provided,
          // A changed parent must be re-resolved.
          ...(event.parentId === undefined ? {} : { parentSpanId: null }),
          ...(derivedStatus === undefined
            ? {}
            : event.status
              ? { status: event.status }
              : {
                  status: sql`CASE WHEN ${spans.status} = 'error' THEN 'error'::trace_status ELSE ${derivedStatus}::trace_status END`,
                }),
        },
      })
      .returning({
        id: spans.id,
        providerId: spans.providerId,
        model: spans.model,
        startedAt: spans.startedAt,
        endedAt: spans.endedAt,
      });
    const span = row!;

    if (event.usage) {
      await this.upsertUsage(tx, job.projectId, span, event.usage);
    }
    if (event.error) {
      await this.upsertError(tx, {
        projectId: job.projectId,
        traceId,
        spanId: span.id,
        error: event.error,
        providerId: span.providerId,
        model: span.model,
        occurredAt: span.endedAt ?? span.startedAt,
      });
    }
  }

  private async upsertUsage(
    tx: Tx,
    projectId: string,
    span: { id: string; providerId: string | null; model: string | null; startedAt: Date },
    usage: NonNullable<SpanEvent['usage']>,
  ): Promise<void> {
    const price =
      span.providerId && span.model
        ? await this.pricing.priceAt(span.providerId, span.model, span.startedAt)
        : null;
    const estimatedCostUsd = price ? estimateCostUsd(usage, price) : null;

    const values = {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      totalTokens: usage.totalTokens ?? usage.inputTokens + usage.outputTokens,
      estimatedCostUsd,
      reportedCostUsd: usage.costUsd === undefined ? null : formatReportedCost(usage.costUsd),
      pricingId: price?.id ?? null,
      recordedAt: span.startedAt,
    };

    await tx
      .insert(tokenUsage)
      .values({ spanId: span.id, projectId, ...values })
      .onConflictDoUpdate({ target: tokenUsage.spanId, set: values });
  }

  private async upsertError(
    tx: Tx,
    input: {
      projectId: string;
      traceId: string;
      spanId: string | null;
      error: ErrorInfoInput;
      providerId?: string | null;
      model?: string | null;
      occurredAt: Date;
    },
  ): Promise<void> {
    const values = {
      type: input.error.type,
      message: input.error.message,
      code: input.error.code ?? null,
      httpStatus: input.error.httpStatus ?? null,
      stack: input.error.stack ?? null,
      providerId: input.providerId ?? null,
      model: input.model ?? null,
      occurredAt: input.occurredAt,
    };
    await tx
      .insert(telemetryErrors)
      .values({
        projectId: input.projectId,
        traceId: input.traceId,
        spanId: input.spanId,
        ...values,
      })
      .onConflictDoUpdate(
        input.spanId === null
          ? {
              target: telemetryErrors.traceId,
              targetWhere: sql`${telemetryErrors.spanId} IS NULL`,
              set: values,
            }
          : {
              target: telemetryErrors.spanId,
              targetWhere: sql`${telemetryErrors.spanId} IS NOT NULL`,
              set: values,
            },
      );
  }

  /** Unknown providers are registered on first sight so the foreign key holds. */
  private async ensureProviders(tx: Tx, events: SpanEvent[]): Promise<void> {
    const providers = [
      ...new Set(events.map((event) => event.provider).filter((value) => value !== undefined)),
    ];
    if (providers.length === 0) return;
    await tx
      .insert(modelProviders)
      .values(providers.map((id) => ({ id, displayName: id })))
      .onConflictDoNothing({ target: modelProviders.id });
  }

  /** Links children to parents by external id, for parents that arrived in this or earlier batches. */
  private async resolveParents(tx: Tx, traceIds: string[]): Promise<void> {
    await tx.execute(sql`
      UPDATE spans AS child
      SET parent_span_id = parent.id
      FROM spans AS parent
      WHERE child.trace_id IN (${sql.join(
        traceIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
        AND child.parent_span_id IS NULL
        AND child.parent_external_id IS NOT NULL
        AND parent.trace_id = child.trace_id
        AND parent.external_id = child.parent_external_id
        AND parent.id <> child.id
    `);
  }

  private async updateDurations(tx: Tx, traceIds: string[]): Promise<void> {
    await tx
      .update(spans)
      .set({
        durationMs: sql`GREATEST(0, ROUND(EXTRACT(EPOCH FROM (${spans.endedAt} - ${spans.startedAt})) * 1000))::int`,
      })
      .where(and(inArray(spans.traceId, traceIds), sql`${spans.endedAt} IS NOT NULL`));
    await tx
      .update(traces)
      .set({
        durationMs: sql`GREATEST(0, ROUND(EXTRACT(EPOCH FROM (${traces.endedAt} - ${traces.startedAt})) * 1000))::int`,
      })
      .where(and(inArray(traces.id, traceIds), sql`${traces.endedAt} IS NOT NULL`));
  }

  /* ------------------------------------------------------------- evaluations */

  private async insertEvaluation(
    context: { tx: Tx; job: IngestionJobData },
    traceId: string,
    event: EvaluationEvent,
  ): Promise<void> {
    const { tx, job } = context;
    let spanId: string | null = null;
    if (event.spanId) {
      const span = await tx.query.spans.findFirst({
        columns: { id: true },
        where: and(eq(spans.traceId, traceId), eq(spans.externalId, event.spanId)),
      });
      if (!span)
        throw new RetryableIngestionError(`Span "${event.spanId}" has not been ingested yet`);
      spanId = span.id;
    }

    const values = {
      criterion: event.criterion,
      kind: event.kind,
      score: event.score ?? null,
      label: event.label ?? null,
      comment: event.comment ?? null,
    };
    const insert = tx.insert(evaluations).values({
      projectId: job.projectId,
      traceId,
      spanId,
      externalId: event.id ?? null,
      source: 'api',
      ...values,
    });
    if (event.id) {
      await insert.onConflictDoUpdate({
        target: [evaluations.projectId, evaluations.externalId],
        targetWhere: sql`${evaluations.externalId} IS NOT NULL`,
        set: values,
      });
    } else {
      await insert;
    }
  }
}
