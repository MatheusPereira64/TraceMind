import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  UnsupportedMediaTypeException,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { ingestBatchSchema, type IngestBatchResponse } from '@tracemind/shared';
import type { z } from 'zod';
import { ApiKeyGuard } from '../api-keys/api-key.guard.js';
import type { ApiKeyPrincipal } from '../auth/auth.types.js';
import { ApiKeyAuth, CurrentApiKey, IngestRateLimit } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { IngestionService } from './ingestion.service.js';
import { mapOtlpTraces, otlpTraceRequestSchema } from './otlp.mapper.js';

interface OtlpExportResponse {
  partialSuccess?: { rejectedSpans: number; errorMessage: string };
}

/**
 * Telemetry endpoints, authenticated by project API key. Rate limited per key (not per IP) and
 * excluded from the per-IP dashboard limit.
 */
@ApiKeyAuth()
@UseGuards(ApiKeyGuard)
@SkipThrottle({ default: true })
@IngestRateLimit()
@Controller('v1/ingest')
export class IngestionController {
  constructor(private readonly ingestion: IngestionService) {}

  /**
   * Accepts up to 1000 events. Valid events are queued (202) even when others are rejected; the
   * response lists every rejected event by index with its validation issues.
   */
  @Post('batch')
  @HttpCode(202)
  batch(
    @CurrentApiKey() principal: ApiKeyPrincipal,
    @Body(new ZodValidationPipe(ingestBatchSchema)) body: z.infer<typeof ingestBatchSchema>,
  ): Promise<IngestBatchResponse> {
    return this.ingestion.ingest(principal, body.events);
  }

  /** OTLP/HTTP trace export, JSON encoding (https://opentelemetry.io/docs/specs/otlp/#otlphttp). */
  @Post('otlp/v1/traces')
  @HttpCode(200)
  async otlpTraces(
    @CurrentApiKey() principal: ApiKeyPrincipal,
    @Headers('content-type') contentType: string | undefined,
    @Body() body: unknown,
  ): Promise<OtlpExportResponse> {
    if (!contentType?.toLowerCase().startsWith('application/json')) {
      throw new UnsupportedMediaTypeException(
        'Only OTLP/HTTP JSON is supported. Set encoding: json on the otlphttp exporter.',
      );
    }
    const parsed = new ZodValidationPipe(otlpTraceRequestSchema).transform(body ?? {});
    const mapped = mapOtlpTraces(parsed);

    let rejectedSpans = mapped.rejectedSpans;
    const messages = [...mapped.errors];
    if (mapped.events.length > 0) {
      const result = await this.ingestion.ingest(principal, mapped.events);
      // A mapped trace event and its root span count as one OTLP span.
      const rejectedSpanEvents = result.rejected.filter(
        (rejection) => (mapped.events[rejection.index] as { type?: string }).type === 'span',
      );
      rejectedSpans += rejectedSpanEvents.length;
      for (const rejection of rejectedSpanEvents.slice(0, 5)) {
        messages.push(
          rejection.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '),
        );
      }
    }

    return rejectedSpans > 0
      ? { partialSuccess: { rejectedSpans, errorMessage: messages.join(' | ').slice(0, 2_000) } }
      : {};
  }
}
