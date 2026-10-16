import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Same-origin in development: the browser talks to Vite, which forwards /api to Nest.
    proxy: {
      '/api': process.env.API_PROXY_TARGET ?? 'http://localhost:3000',
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['src/test/setup.ts'],
    // Run in a timezone west of UTC so date-shifting bugs on calendar dates fail loudly.
    env: { TZ: 'America/Sao_Paulo' },
    // Page tests type into real forms through jsdom; the longest take seconds on a loaded
    // machine, and the default of 5 s made them fail by timing, not by behaviour.
    testTimeout: 15_000,
  },
});
