import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { configureApp } from './bootstrap.js';
import { ENV, type Env } from './config/env.js';

/** Local convenience: load apps/api/.env when present. Production gets real environment vars. */
function loadLocalEnvFile(): void {
  const path = new URL('../.env', import.meta.url);
  if (process.env.NODE_ENV !== 'production' && existsSync(path)) process.loadEnvFile(path);
}

async function bootstrap(): Promise<void> {
  loadLocalEnvFile();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    bodyParser: false,
  });

  const env = app.get<Env>(ENV);
  configureApp(app, env);

  await app.listen(env.PORT, '0.0.0.0');
}

await bootstrap();
