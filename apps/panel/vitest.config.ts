import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Intégration panel↔agent réels (fake Java server) : délais réels.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Runners CI partagés (2 cœurs) : les cadences temps réel y sont non déterministes — deux
    // reprises absorbent l'aléa, un vrai bug échoue trois fois. Zéro reprise en local.
    retry: process.env.CI === undefined ? 0 : 2,
  },
});
