import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/** Owns both servers; never uses DATABASE_URL, .env, or the development database. */
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['test/storage/**/*.storage-spec.ts'],
    globalSetup: ['test/storage/global-setup.ts'],
    fileParallelism: false,
    hookTimeout: 60_000,
    testTimeout: 60_000,
  },
});
