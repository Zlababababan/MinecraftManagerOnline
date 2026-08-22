/**
 * E2E Playwright (doc 07 phase 5) : desktop + mobile, fr + en, contre le panel réel + agent réel +
 * fake Java server (`e2e/fixtures/stack.ts`). Le projet `setup` exécute le wizard et l'appairage une
 * fois ; les quatre projets de flux en dépendent et s'exécutent en série (un seul serveur Minecraft).
 * Phase 6 : `whitelist.spec.ts` = « gérer une whitelist depuis un téléphone sans jamais voir un fichier ».
 * Phase 7 : `metrics.spec.ts` = graphiques alimentés en direct, TPS indisponible dit franchement.
 * Phase 12 : `settings.spec.ts` = thèmes, notifications, Réglages admin (joignabilité, distribution).
 */
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.MMO_E2E_PORT ?? 3999);
const BASE_URL = `http://127.0.0.1:${String(PORT)}`;

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'pnpm exec vite build && pnpm exec tsx e2e/fixtures/stack.ts',
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
  projects: [
    {
      name: 'setup',
      testMatch: /setup\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], locale: 'fr-FR' },
    },
    {
      name: 'desktop-fr',
      testMatch:
        /flow\.spec\.ts|whitelist\.spec\.ts|metrics\.spec\.ts|backups\.spec\.ts|pwa\.spec\.ts|settings.spec.ts|a11y.spec.ts/,
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], locale: 'fr-FR' },
    },
    {
      name: 'desktop-en',
      testMatch:
        /flow\.spec\.ts|whitelist\.spec\.ts|metrics\.spec\.ts|backups\.spec\.ts|settings.spec.ts|a11y.spec.ts/,
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], locale: 'en-US' },
    },
    {
      name: 'mobile-fr',
      testMatch:
        /flow\.spec\.ts|whitelist\.spec\.ts|metrics\.spec\.ts|backups\.spec\.ts|settings.spec.ts|a11y.spec.ts/,
      dependencies: ['setup'],
      use: { ...devices['Pixel 7'], locale: 'fr-FR' },
    },
    {
      name: 'mobile-en',
      testMatch:
        /flow\.spec\.ts|whitelist\.spec\.ts|metrics\.spec\.ts|backups\.spec\.ts|settings.spec.ts|a11y.spec.ts/,
      dependencies: ['setup'],
      use: { ...devices['Pixel 7'], locale: 'en-US' },
    },
  ],
});
