import { existsSync } from 'node:fs';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';
import { APP_CONFIG, type AppConfig } from './config/app-config.js';

// Local development convenience; deployed environments inject real environment variables.
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

const app = configureApp(await NestFactory.create(AppModule));
const { port, host } = app.get<AppConfig>(APP_CONFIG);
await (host === undefined ? app.listen(port) : app.listen(port, host));
Logger.log(
  `API listening on http://${host ?? 'localhost'}:${port}/api (docs at /api/docs)`,
  'Bootstrap',
);
