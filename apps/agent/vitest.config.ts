import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Tests d'intégration (fake Java server, faux panel WebSocket) : délais réels.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
