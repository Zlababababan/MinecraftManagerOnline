/**
 * Retours du 02/10 joués dans un vrai navigateur, avec un vrai agent :
 * - une valeur de l'aperçu mène à son champ, mis en avant et visible à l'arrivée ;
 * - changer `query.port` seul prévient, et mène au port de jeu ;
 * - le port affiché suit le fichier dès l'enregistrement (serveur arrêté) ;
 * - l'audit dit quelle clé a changé, de quelle valeur à quelle valeur ;
 * - les IP sont floutées par défaut, l'interrupteur de l'en-tête les affiche et s'en souvient.
 */
import { expect, test } from '@playwright/test';

import { langOf, login } from './helpers.js';

test('aperçu → champ mis en avant, deux ports, port affiché, audit précis, données floutées', async ({
  page,
}, testInfo) => {
  await login(page, langOf(testInfo.project.use.locale));
  await page.getByTestId('server-card').getByTestId('server-link').click();
  await expect(page.getByTestId('server-page')).toBeVisible();
  const serverId = (await page.getByTestId('server-page').getAttribute('data-server-id')) ?? '';

  // 1. Le port de l'aperçu est un lien vers son champ.
  const before = (await page.getByTestId('field-game-port').innerText()).trim();
  await page.getByTestId('field-game-port').click();
  await expect(page).toHaveURL(/tab=config/);
  await expect(page).toHaveURL(/focus=server-port/);
  const target = page.locator('[data-focus-target="server-port"]');
  await expect(target).toHaveClass(/mmo-focus/);
  await expect(target).toBeInViewport();
  await expect(page.locator('.mmo-focus')).toHaveCount(1);
  await expect(page.getByTestId('prop-server-port')).toHaveValue(before);

  // 2. Le piège : changer query.port seul prévient ; le bouton ramène au port de jeu.
  await expect(page.getByTestId('properties-warning-queryPortOnly')).toHaveCount(0);
  await page.getByTestId('prop-query.port').fill('25571');
  await expect(page.getByTestId('properties-warning-queryPortOnly')).toBeVisible();
  await page.getByTestId('properties-warning-queryPortOnly-show').click();
  await expect(target).toHaveClass(/mmo-focus/);

  // 3. Changer aussi le port de jeu : plus d'avertissement ; enregistré, l'aperçu suit sans scan.
  const next = String(Number(before) + 1);
  await page.getByTestId('prop-server-port').fill(next);
  await expect(page.getByTestId('properties-warning-queryPortOnly')).toHaveCount(0);
  await page.getByTestId('properties-save').click();
  await expect(page.getByTestId('properties-changes')).toContainText('0');
  await page.getByTestId('tab-overview').click();
  await expect(page.getByTestId('field-game-port')).toHaveText(next);

  // 4. L'audit dit exactement ce qui a changé.
  const audit = await page.request.get('/api/audit');
  const entry = (
    (await audit.json()) as { audit: { action: string; details: { changes?: unknown } }[] }
  ).audit.find((e) => e.action === 'server.configChanged');
  expect(entry?.details.changes).toEqual({
    keys: {
      'server-port': { from: before, to: next },
      'query.port': { from: null, to: '25571' },
    },
  });

  // On remet le serveur comme il était pour les autres parcours.
  const restore = await page.request.put(`/api/servers/${serverId}/config/server.properties`, {
    data: { data: { 'server-port': before, 'query.port': null } },
  });
  expect(restore.ok()).toBeTruthy();

  // 5. Données sensibles : l'IP de l'audit est floue ; l'en-tête affiche tout et s'en souvient.
  await page.goto('/settings?section=accounts');
  const hidden = page.locator('tr[data-testid^="audit-"] [data-sensitive="hidden"]');
  await expect(hidden.first()).toBeVisible();
  await expect(hidden.first()).toHaveCSS('filter', /blur/);
  await page.getByTestId('sensitive-toggle').click();
  await expect(hidden).toHaveCount(0);
  await page.reload();
  await expect(
    page.locator('tr[data-testid^="audit-"] [data-sensitive="revealed"]').first(),
  ).toBeVisible();
  await expect(hidden).toHaveCount(0);
  await page.getByTestId('sensitive-toggle').click();
  await expect(hidden.first()).toBeVisible();
});
