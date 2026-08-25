/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// Dev : le panel tourne sur 3000 (`pnpm --filter @mmo/panel dev`), Vite proxifie /api et /ws.
const PANEL = process.env.MMO_PANEL_URL ?? 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'MinecraftManagerOnline',
        short_name: 'MMO',
        description: 'Remote control for self-hosted Minecraft servers',
        lang: 'fr',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'any',
        background_color: '#141517',
        theme_color: '#141517',
        icons: [
          { src: '/pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // L'API et les WebSockets ne passent jamais par le service worker.
        navigateFallbackDenylist: [/^\/api\//, /^\/ws\//],
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // Phase 10 : gestion du push (affichage, clic, rotation d'abonnement) hors du SW généré.
        importScripts: ['sw-push.js'],
        globIgnores: ['**/sw-push.js'],
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: PANEL, changeOrigin: false },
      '/ws': { target: PANEL, ws: true },
    },
  },
  build: {
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
  },
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    alias: {
      'virtual:pwa-register/react': path.resolve(import.meta.dirname, 'src/test/pwa-register.ts'),
    },
    environment: 'jsdom',
    setupFiles: ['src/test/setup.ts'],
    css: false,
    // jsdom + userEvent : les 5 s par défaut débordent sur les runners CI lents et sous turbo
    // parallèle local (piège 64) — les tests rapides restent rapides.
    testTimeout: process.env.CI === undefined ? 20_000 : 60_000,
    // Deux reprises sur CI : absorbe l'aléa de cadence des runners partagés, zéro en local.
    retry: process.env.CI === undefined ? 0 : 2,
  },
});
