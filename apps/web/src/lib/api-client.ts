import type { ApiErrorBody } from '@tracemind/shared';

/**
 * Browser calls go to the same-origin `/api` proxy (src/app/api/[...path]/route.ts), so the
 * httpOnly session cookie is first-party and no CORS is involved.
 */
const BASE = '/api';

export class ApiError extends Error {
  readonly status: number;
  readonly issues: ApiErrorBody['issues'];
  readonly requestId: string | undefined;

  constructor(status: number, body: Partial<ApiErrorBody> | undefined) {
    super(body?.message ?? `Request failed with status ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.issues = body?.issues;
    this.requestId = body?.requestId;
  }

  /** Message for a given form field, if the API reported one. */
  fieldError(path: string): string | undefined {
    return this.issues?.find((issue) => issue.path === path)?.message;
  }
}

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, { message: 'Could not reach the TraceMind API. Check your connection.' });
  }

  if (response.status === 204) return undefined as T;

  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) throw new ApiError(response.status, payload as Partial<ApiErrorBody>);
  return payload as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
};
