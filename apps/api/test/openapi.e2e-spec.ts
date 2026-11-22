import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { ModulesContainer } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { OPERATIONS } from '../src/openapi/operations.js';
import { createTestApp } from './test-app.js';

/** Routes that are intentionally not part of the JSON API description. */
const UNDOCUMENTED = new Set(['get /docs']);

function join(...parts: string[]): string {
  const path = parts
    .flatMap((part) => part.split('/'))
    .filter(Boolean)
    .map((segment) => (segment.startsWith(':') ? `{${segment.slice(1)}}` : segment))
    .join('/');
  return `/${path}`;
}

/** Every route registered by the application's controllers, as `method /openapi/{path}`. */
function registeredRoutes(app: NestExpressApplication): string[] {
  const routes: string[] = [];
  for (const module of app.get(ModulesContainer).values()) {
    for (const wrapper of module.controllers.values()) {
      const controller = wrapper.metatype as (new (...args: never[]) => unknown) | null;
      if (!controller) continue;
      const base = Reflect.getMetadata(PATH_METADATA, controller) as string | string[];
      const prototype = controller.prototype as Record<string, unknown>;
      for (const name of Object.getOwnPropertyNames(prototype)) {
        const handler = prototype[name];
        if (typeof handler !== 'function' || name === 'constructor') continue;
        const path = Reflect.getMetadata(PATH_METADATA, handler) as string | string[] | undefined;
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
        if (path === undefined || method === undefined) continue;
        for (const basePath of [base].flat()) {
          for (const routePath of [path].flat()) {
            routes.push(`${RequestMethod[method].toLowerCase()} ${join(basePath, routePath)}`);
          }
        }
      }
    }
  }
  return routes.sort();
}

describe('OpenAPI (e2e)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('documents exactly the routes the API exposes', () => {
    const registered = registeredRoutes(app).filter((route) => !UNDOCUMENTED.has(route));
    const documented = OPERATIONS.map(
      (operation) => `${operation.method} ${operation.path}`,
    ).sort();
    expect(registered.length).toBeGreaterThan(30);
    expect(documented).toEqual(registered);
  });

  it('serves the document without authentication', async () => {
    const response = await request(app.getHttpServer()).get('/v1/openapi.json').expect(200);
    expect(response.headers['content-type']).toMatch(/application\/json/);
    expect(response.body).toMatchObject({
      openapi: '3.1.0',
      info: { title: 'TraceMind API' },
      servers: [{ url: '/' }],
    });
    expect(Object.keys(response.body.paths as object)).toContain('/v1/ingest/batch');
  });

  it('serves the API reference page with a strict, per-request CSP', async () => {
    const first = await request(app.getHttpServer()).get('/docs').expect(200);
    const second = await request(app.getHttpServer()).get('/docs').expect(200);
    expect(first.headers['content-type']).toMatch(/text\/html/);

    const csp = first.headers['content-security-policy'] as string;
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toContain('unsafe-eval');
    expect(second.headers['content-security-policy']).not.toBe(csp);

    // Every script carries the nonce; the external one is pinned with SRI.
    const scripts = [...first.text.matchAll(/<script([^>]*)>/g)].map((match) => match[1]!);
    expect(scripts).toHaveLength(2);
    for (const attributes of scripts) expect(attributes).toContain(`nonce="${nonce}"`);
    expect(scripts[0]).toMatch(/integrity="sha384-[A-Za-z0-9+/=]+"/);
  });
});
