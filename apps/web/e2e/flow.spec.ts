/**
 * Critère « terminé quand » de la phase 5 (doc 07), joué en desktop + mobile, fr + en :
 * login → dashboard → start d'un serveur → commande console → réponse visible → stop.
 */
import { expect, test } from '@playwright/test';

import { TEXT, langOf, login, waitForServerState } from './helpers.js';

test('login → dashboard → start → commande console → réponse → stop', async ({
  page,
  isMobile,
}, testInfo) => {
  const lang = langOf(testInfo.project.use.locale);
  const t = TEXT[lang];
  const tag = `${testInfo.project.name}-${String(Date.now() % 100_000)}`;

  await login(page, lang);
  await expect(page.getByRole('heading', { name: t.dashboard })).toBeVisible();
  // Navigation : barre latérale sur desktop, navigation basse sur mobile.
  if (isMobile) {
    await expect(page.getByTestId('bottom-nav')).toBeVisible();
    await expect(page.getByTestId('nav-dashboard')).not.toBeInViewport();
  } else {
    await expect(page.getByTestId('nav-dashboard')).toBeVisible();
    await expect(page.getByTestId('bottom-nav')).toBeHidden();
  }

  // Dashboard : machine en ligne + carte serveur à l'arrêt.
  await expect(page.getByTestId('machine-status')).toHaveAttribute('data-status', 'online');
  const card = page.getByTestId('server-card');
  await expect(card).toHaveCount(1);
  await expect(card.getByTestId('run-state')).toHaveText(t.stopped);

  // Start depuis la carte → état temps réel « En marche » (via /ws/client).
  await card.getByTestId('action-start').click();
  await expect(card.getByTestId('run-state')).toHaveText(t.running, { timeout: 20_000 });
  await expect(page.getByTestId('stat-running')).toHaveText('1');

  // Page serveur → onglet Console : snapshot (Done), commande, réponse visible.
  await card.getByTestId('server-link').click();
  await expect(page.getByTestId('server-page')).toBeVisible();
  await page.getByTestId('tab-console').click();
  await expect(page).toHaveURL(/tab=console/);
  await expect(page.getByTestId('console')).toBeVisible();
  const mirror = page.getByTestId('console-mirror');
  await expect(mirror).toContainText('Done (', { timeout: 20_000 });
  await expect(page.locator('.xterm-rows')).toContainText('Done');

  const input = page.getByTestId('console-input');
  await input.fill(`say hello-${tag}`);
  await input.press('Enter');
  await expect(mirror).toContainText(`[Server] hello-${tag}`, { timeout: 20_000 });
  await expect(input).toHaveValue('');
  // Historique ↑ et complétion Tab.
  await input.press('ArrowUp');
  await expect(input).toHaveValue(`say hello-${tag}`);
  await input.fill('whitel');
  await input.press('Tab');
  await expect(input).toHaveValue('whitelist ');
  await input.fill('');

  // Joueur (Alice rejoint après Done) visible dans l'onglet Joueurs.
  await page.getByTestId('tab-players').click();
  await expect(page.getByTestId('players')).toContainText('Alice', { timeout: 20_000 });

  // Stop depuis l'en-tête → « Arrêté » (temps réel), puis vérification API.
  await page.getByTestId('action-stop').click();
  await expect(page.getByTestId('run-state')).toHaveText(t.stopped, { timeout: 30_000 });
  const serverId = await page.getByTestId('server-page').getAttribute('data-server-id');
  expect(serverId).toBeTruthy();
  await waitForServerState(page.request, serverId ?? '', 'stopped');
});

test('langue et thème persistés sur le compte', async ({ page }, testInfo) => {
  const lang = langOf(testInfo.project.use.locale);
  await login(page, lang);
  await page.getByTestId('theme-menu').click();
  await page.getByTestId('theme-light').click();
  await expect(page.locator('html')).toHaveAttribute('data-mantine-color-scheme', 'light');
  await page.getByTestId('theme-menu').click();
  await page.getByTestId('theme-dark').click();
  await expect(page.locator('html')).toHaveAttribute('data-mantine-color-scheme', 'dark');
  await page.getByTestId('lang-menu').click();
  await page.getByTestId(lang === 'fr' ? 'lang-en' : 'lang-fr').click();
  const other = lang === 'fr' ? 'en' : 'fr';
  await expect(page.getByRole('heading', { name: TEXT[other].dashboard })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', other);
  // La préférence est rechargée depuis le compte.
  await page.reload();
  await expect(page.getByRole('heading', { name: TEXT[other].dashboard })).toBeVisible();
  // Retour à la langue du projet pour les tests suivants.
  await page.getByTestId('lang-menu').click();
  await page.getByTestId(`lang-${lang}`).click();
  await expect(page.getByRole('heading', { name: TEXT[lang].dashboard })).toBeVisible();
});
