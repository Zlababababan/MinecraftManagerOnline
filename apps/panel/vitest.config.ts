import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Intégration panel↔agent réels (fake Java server) : délais réels.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
