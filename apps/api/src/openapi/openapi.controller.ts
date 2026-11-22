import { Controller, Get, Header, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Public } from '../auth/decorators.js';

/** Works from src/openapi (tsx, tests) and dist/openapi (compiled). */
export const OPENAPI_DOCUMENT_PATH = fileURLToPath(
  new URL('../../openapi/openapi.json', import.meta.url),
);

/** Pinned API reference renderer, loaded with Subresource Integrity. */
const SCALAR_VERSION = '1.82.1';
const SCALAR_SRC = `https://cdn.jsdelivr.net/npm/@scalar/api-reference@${SCALAR_VERSION}/dist/browser/standalone.js`;
const SCALAR_INTEGRITY = 'sha384-3llXraiLKrfG/eL4517CCzYH4wdaQ+bXhZeTcZKnEyJUu2vwIdsFBOVMa3m5lD4h';

function loadDocument(): string {
  const document = JSON.parse(readFileSync(OPENAPI_DOCUMENT_PATH, 'utf8')) as Record<
    string,
    unknown
  >;
  // Served by the API itself, so "try it" requests go to the origin the reader is on.
  return JSON.stringify({ ...document, servers: [{ url: '/', description: 'This server' }] });
}

/** OpenAPI document and a browsable API reference. Public: they describe, never expose, data. */
@Public()
@SkipThrottle()
@Controller()
export class OpenApiController {
  private readonly document = loadDocument();

  @Get('v1/openapi.json')
  @Header('Content-Type', 'application/json; charset=utf-8')
  @Header('Cache-Control', 'public, max-age=300')
  openapi(): string {
    return this.document;
  }

  @Get('docs')
  docs(@Res() response: Response): void {
    const nonce = randomBytes(16).toString('base64');
    response.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        `script-src 'nonce-${nonce}' https://cdn.jsdelivr.net`,
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "font-src 'self' data:",
        "connect-src 'self'",
        "frame-ancestors 'none'",
        "base-uri 'none'",
        "form-action 'none'",
      ].join('; '),
    );
    response.type('html').send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>TraceMind API reference</title>
  </head>
  <body>
    <div id="app"></div>
    <script nonce="${nonce}" src="${SCALAR_SRC}" integrity="${SCALAR_INTEGRITY}" crossorigin="anonymous"></script>
    <script nonce="${nonce}">
      Scalar.createApiReference('#app', {
        url: '/v1/openapi.json',
        theme: 'purple',
        darkMode: true,
        withDefaultFonts: false,
        hideClientButton: true,
      });
    </script>
  </body>
</html>
`);
  }
}
