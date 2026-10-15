import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

const testDatabaseUrl =
  process.env.TEST_DATABASE_URL ?? 'postgresql://tradeflow:tradeflow@localhost:5433/tradeflow_test';

export default defineConfig({
  // Nest's dependency injection relies on emitted decorator metadata, which esbuild cannot produce.
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.spec.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['test/**/*.int-spec.ts'],
          globalSetup: ['test/support/global-setup.ts'],
          env: { NODE_ENV: 'test', DATABASE_URL: testDatabaseUrl },
          // All integration files share one database; run them one at a time.
          fileParallelism: false,
        },
      },
    ],
  },
});
