import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Tests d'intégration (fake Java server, faux panel WebSocket) : délais réels. Sur CI les
    // attentes des helpers sont ×3 : les budgets suivent.
    testTimeout: process.env.CI === undefined ? 30_000 : 180_000,
    hookTimeout: process.env.CI === undefined ? 30_000 : 180_000,
    // Runners CI partagés (2 cœurs) : les cadences temps réel y sont non déterministes — deux
    // reprises absorbent l'aléa, un vrai bug échoue trois fois. Zéro reprise en local.
    retry: process.env.CI === undefined ? 0 : 2,
  },
});
