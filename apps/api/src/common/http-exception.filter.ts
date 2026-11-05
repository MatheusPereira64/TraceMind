import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { ApiErrorBody } from '@tracemind/shared';
import type { Request, Response } from 'express';

const PG_UNIQUE_VIOLATION = '23505';
const PG_FOREIGN_KEY_VIOLATION = '23503';

function isPgError(error: unknown): error is { code: string; constraint?: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string'
  );
}

/** Unwraps drizzle's DrizzleQueryError, which wraps the driver error in `cause`. */
function pgErrorOf(error: unknown): { code: string; constraint?: string } | undefined {
  if (isPgError(error) && /^[0-9A-Z]{5}$/.test(error.code)) return error;
  const cause = (error as { cause?: unknown } | null)?.cause;
  return cause ? pgErrorOf(cause) : undefined;
}

/**
 * Normalizes every error into ApiErrorBody. Unknown errors are logged with their stack and
 * returned as a generic 500 so internals (SQL, stack traces) never reach the client.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<Request>();
    const requestId = request.id === undefined ? undefined : String(request.id);

    const body = this.toBody(exception);
    if (body.statusCode >= 500) {
      this.logger.error(
        { err: exception, requestId, path: request.url },
        'Unhandled error while processing request',
      );
    }

    response.status(body.statusCode).json({ ...body, requestId });
  }

  private toBody(exception: unknown): ApiErrorBody {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const raw = exception.getResponse();
      const payload = typeof raw === 'string' ? { message: raw } : (raw as Record<string, unknown>);
      const message = Array.isArray(payload.message)
        ? payload.message.join('; ')
        : String(payload.message ?? exception.message);
      return {
        statusCode: status,
        error: HttpStatus[status] ?? 'Error',
        message,
        ...(Array.isArray(payload.issues)
          ? { issues: payload.issues as ApiErrorBody['issues'] }
          : {}),
      };
    }

    const pgError = pgErrorOf(exception);
    if (pgError?.code === PG_UNIQUE_VIOLATION) {
      return { statusCode: 409, error: 'CONFLICT', message: 'Resource already exists' };
    }
    if (pgError?.code === PG_FOREIGN_KEY_VIOLATION) {
      return { statusCode: 409, error: 'CONFLICT', message: 'Referenced resource does not exist' };
    }

    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      error: 'INTERNAL_SERVER_ERROR',
      message: 'Internal server error',
    };
  }
}
