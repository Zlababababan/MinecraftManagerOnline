/**
 * PWA installable (critère doc 07 phase 5). Lighthouse ≥ 12 n'a plus de catégorie PWA : on vérifie
 * directement les critères d'installabilité de Chrome — manifest valide (nom, start_url, display
 * standalone, icônes 192 + 512 PNG), service worker enregistré et contrôlant la page, et
 * fonctionnement hors ligne (coquille servie par le cache Workbox).
 */
import { expect, test } from '@playwright/test';

import { login } from './helpers.js';

interface Manifest {
  name: string;
  short_name: string;
  start_url: string;
  display: string;
  icons: { src: string; sizes: string; type: string; purpose?: string }[];
}

test('manifest, service worker et mode hors ligne', async ({ page, context, request }) => {
  await login(page, 'fr');
  const link = page.locator('link[rel="manifest"]');
  await expect(link).toHaveAttribute('href', /manifest\.webmanifest/);
  const manifestRes = await request.get('/manifest.webmanifest');
  expect(manifestRes.ok()).toBeTruthy();
  const manifest = (await manifestRes.json()) as Manifest;
  expect(manifest.name).toBe('MinecraftManagerOnline');
  expect(manifest.short_name).toBe('MMO');
  expect(manifest.display).toBe('standalone');
  expect(manifest.start_url).toBe('/');
  const sizes = manifest.icons.filter((i) => i.type === 'image/png').map((i) => i.sizes);
  expect(sizes).toEqual(expect.arrayContaining(['192x192', '512x512']));
  expect(manifest.icons.some((i) => i.purpose === 'maskable')).toBe(true);
  for (const icon of manifest.icons) {
    const res = await request.get(icon.src);
    expect(res.ok(), icon.src).toBeTruthy();
    expect(res.headers()['content-type']).toContain('image/png');
  }
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', /#/);

  // Service worker enregistré et actif.
  const swState = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    return { scope: reg.scope, active: reg.active?.state ?? null };
  });
  expect(swState.active).toBe('activated');
  expect(swState.scope).toMatch(/\/$/);
  // Recharger pour que le SW contrôle la page, puis couper le réseau : la coquille se charge encore.
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await context.setOffline(true);
  await page.goto('/login');
  await expect(page).toHaveTitle(/MinecraftManagerOnline/);
  await expect(page.locator('#root')).not.toBeEmpty();
  await context.setOffline(false);
});
