import type { NextRequest } from 'next/server';

/**
 * Same-origin proxy to the TraceMind API. Keeps the session cookie first-party, avoids CORS in
 * the browser, and lets the API URL be configured at runtime (API_INTERNAL_URL) instead of being
 * baked into the client bundle.
 */
export const dynamic = 'force-dynamic';

const API_URL = (process.env.API_INTERNAL_URL ?? 'http://localhost:4000').replace(/\/$/, '');

/** Only these request headers are forwarded; everything else (host, connection…) is dropped. */
const FORWARDED_REQUEST_HEADERS = [
  'content-type',
  'cookie',
  'authorization',
  'x-request-id',
  'accept',
];
const FORWARDED_RESPONSE_HEADERS = [
  'content-type',
  'x-request-id',
  'retry-after',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
];

async function proxy(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  // Only the versioned API and health checks are reachable through the proxy.
  if (path[0] !== 'v1' && path[0] !== 'health') {
    return Response.json(
      { statusCode: 404, error: 'NOT_FOUND', message: 'Not found' },
      { status: 404 },
    );
  }

  const target = new URL(`${API_URL}/${path.map(encodeURIComponent).join('/')}`);
  target.search = request.nextUrl.search;

  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const forwardedFor = request.headers.get('x-forwarded-for');
  if (forwardedFor) headers.set('x-forwarded-for', forwardedFor);

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      body: hasBody ? await request.arrayBuffer() : undefined,
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    return Response.json(
      { statusCode: 502, error: 'BAD_GATEWAY', message: 'The TraceMind API is unreachable' },
      { status: 502 },
    );
  }

  const responseHeaders = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  for (const cookie of upstream.headers.getSetCookie())
    responseHeaders.append('set-cookie', cookie);

  return new Response(upstream.status === 204 ? null : upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

export { proxy as DELETE, proxy as GET, proxy as PATCH, proxy as POST };
