import type { IngestEvent } from '../src/types.js';

export interface RecordedRequest {
  url: string;
  headers: Record<string, string>;
  events: IngestEvent[];
}

type Responder = (request: RecordedRequest, attempt: number) => Response | Promise<Response>;

export const accepted = (count: number) =>
  new Response(JSON.stringify({ batchId: '1', accepted: count, rejected: [] }), {
    status: 202,
    headers: { 'content-type': 'application/json' },
  });

/** Fake fetch that records requests and answers through `responder`. */
export function fakeFetch(responder: Responder = (request) => accepted(request.events.length)) {
  const requests: RecordedRequest[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { events: IngestEvent[] };
    const request: RecordedRequest = {
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      events: body.events,
    };
    requests.push(request);
    return responder(request, requests.length);
  }) as typeof globalThis.fetch;
  return { fetch, requests, events: () => requests.flatMap((request) => request.events) };
}
