import { Global, Module } from '@nestjs/common';
import { z } from 'zod';

const EnvironmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  // Absolute session lifetime: a working day by default, at most a week (ADR 0007).
  SESSION_TTL_MINUTES: z.coerce
    .number()
    .int()
    .min(5)
    .max(7 * 24 * 60)
    .default(8 * 60),
});

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  databaseUrl: string;
  session: {
    ttlMs: number;
    /** Secure (HTTPS-only) cookies everywhere except local development and tests over HTTP. */
    secureCookie: boolean;
  };
}

export const APP_CONFIG = Symbol('APP_CONFIG');

/** Fails fast at startup with every invalid variable listed, instead of failing on first use. */
export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const result = EnvironmentSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid environment configuration:\n${z.prettifyError(result.error)}`);
  }
  const { NODE_ENV, PORT, DATABASE_URL, SESSION_TTL_MINUTES } = result.data;
  return {
    nodeEnv: NODE_ENV,
    port: PORT,
    databaseUrl: DATABASE_URL,
    session: { ttlMs: SESSION_TTL_MINUTES * 60_000, secureCookie: NODE_ENV === 'production' },
  };
}

@Global()
@Module({
  providers: [{ provide: APP_CONFIG, useFactory: () => loadConfig(process.env) }],
  exports: [APP_CONFIG],
})
export class ConfigModule {}
