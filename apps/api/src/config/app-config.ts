import { resolve } from 'node:path';
import { Global, Module } from '@nestjs/common';
import { z } from 'zod';

/** Where uploaded documents are kept outside production, relative to the working directory. */
const DEFAULT_DOCUMENT_STORAGE_DIR = 'var/documents';

const EnvironmentSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    // Interface to listen on; every interface when unset. The local demo binds to 127.0.0.1.
    HOST: z.string().trim().min(1).optional(),
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    // Absolute session lifetime: a working day by default, at most a week (ADR 0007).
    SESSION_TTL_MINUTES: z.coerce
      .number()
      .int()
      .min(5)
      .max(7 * 24 * 60)
      .default(8 * 60),
    // Sign-in attempts per client address per minute (ADR 0018). Raise it only where many
    // users share one address, such as behind a proxy whose hops are not trusted.
    SIGN_IN_ATTEMPTS_PER_MINUTE: z.coerce.number().int().min(1).max(100_000).default(20),
    // Private directory for uploaded document bytes (ADR 0013). Never served statically.
    DOCUMENT_STORAGE_DIR: z.string().trim().min(1).optional(),
  })
  .superRefine((env, context) => {
    // A deployment must say where evidence is kept; a default under the working directory
    // could land on an ephemeral filesystem.
    if (env.NODE_ENV === 'production' && env.DOCUMENT_STORAGE_DIR === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['DOCUMENT_STORAGE_DIR'],
        message: 'Required in production',
      });
    }
  });

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  /** Interface the server listens on; undefined: every interface. */
  host: string | undefined;
  databaseUrl: string;
  session: {
    ttlMs: number;
    /** Secure (HTTPS-only) cookies everywhere except local development and tests over HTTP. */
    secureCookie: boolean;
  };
  signIn: {
    /** Attempts one client address may make per one-minute window (ADR 0018). */
    attemptsPerMinute: number;
  };
  documentStorage: {
    /** Absolute path of the private directory that holds uploaded document bytes. */
    directory: string;
  };
}

export const APP_CONFIG = Symbol('APP_CONFIG');

/** Fails fast at startup with every invalid variable listed, instead of failing on first use. */
export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const result = EnvironmentSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid environment configuration:\n${z.prettifyError(result.error)}`);
  }
  const {
    NODE_ENV,
    PORT,
    HOST,
    DATABASE_URL,
    SESSION_TTL_MINUTES,
    SIGN_IN_ATTEMPTS_PER_MINUTE,
    DOCUMENT_STORAGE_DIR,
  } = result.data;
  return {
    nodeEnv: NODE_ENV,
    port: PORT,
    host: HOST,
    databaseUrl: DATABASE_URL,
    session: { ttlMs: SESSION_TTL_MINUTES * 60_000, secureCookie: NODE_ENV === 'production' },
    signIn: { attemptsPerMinute: SIGN_IN_ATTEMPTS_PER_MINUTE },
    documentStorage: {
      directory: resolve(DOCUMENT_STORAGE_DIR ?? DEFAULT_DOCUMENT_STORAGE_DIR),
    },
  };
}

@Global()
@Module({
  providers: [{ provide: APP_CONFIG, useFactory: () => loadConfig(process.env) }],
  exports: [APP_CONFIG],
})
export class ConfigModule {}
