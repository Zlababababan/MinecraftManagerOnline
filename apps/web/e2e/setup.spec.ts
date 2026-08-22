/**
 * Projet `setup` (une fois) : wizard first-run → ajout d'une machine (code affiché une seule fois)
 * → appairage de l'agent réel → répertoire surveillé → scan → serveur adopté visible.
 */
import { expect, test } from '@playwright/test';

import { ADMIN } from './helpers.js';

test.describe.configure({ mode: 'serial' });

test('wizard first-run, appairage et scan', async ({ page, request }) => {
  // 1. Toute page protégée renvoie vers le wizard tant qu'aucun utilisateur n'existe.
  await page.goto('/machines');
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByTestId('setup')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Bienvenue' })).toBeVisible();

  await page.getByTestId('setup-username').fill(ADMIN.username);
  await page.getByTestId('setup-password').fill('short');
  await page.getByTestId('setup-password-confirm').fill('short');
  await page.getByTestId('setup-next').click();
  // Validation côté client : mot de passe trop court → on reste à l'étape 1.
  await expect(page.getByTestId('setup-username')).toBeVisible();
  await page.getByTestId('setup-password').fill(ADMIN.password);
  await page.getByTestId('setup-password-confirm').fill(ADMIN.password);
  await page.getByTestId('setup-next').click();
  await expect(page.getByTestId('setup-public-url')).toBeVisible();
  await page.getByTestId('setup-public-url').fill('http://127.0.0.1:3999');
  await page.getByTestId('setup-submit').click();

  // 2. Dashboard vide, puis « Ajouter une machine » → code d'appairage + one-liners.
  await expect(page.getByTestId('dashboard')).toBeVisible();
  await expect(page.getByTestId('no-machines')).toBeVisible();
  await page.getByTestId('dashboard-add-machine').click();
  await expect(page).toHaveURL(/\/machines\?add=true$/);
  await page.getByTestId('machine-name').fill('Tour');
  await page.getByTestId('machine-create').click();
  await expect(page.getByTestId('pairing-card')).toBeVisible();
  const code = (await page.getByTestId('pairing-code').textContent())?.trim() ?? '';
  expect(code.length).toBeGreaterThanOrEqual(6);
  await expect(page.getByText('install.ps1')).toBeVisible();
  await expect(page.getByText('install.sh')).toBeVisible();
  await page.getByTestId('pairing-close').click();
  await expect(page.getByTestId('machine-row')).toHaveCount(1);
  await expect(page.getByTestId('machine-status')).toHaveAttribute('data-status', 'pending');

  // 3. Agent réel démarré avec ce code → la machine passe en ligne (temps réel, sans recharger).
  const start = await request.post('/e2e/agent/start', { data: { pairCode: code } });
  expect(start.ok()).toBeTruthy();
  await expect(page.getByTestId('machine-status')).toHaveAttribute('data-status', 'online', {
    timeout: 20_000,
  });

  // 4. Page machine : répertoire surveillé + scan → serveur Vanilla adopté.
  const info = (await (await request.get('/e2e/info')).json()) as { serversRoot: string };
  await page.getByTestId('machine-link').click();
  await expect(page.getByTestId('machine-page')).toBeVisible();
  await page.getByTestId('directory-path').fill(info.serversRoot);
  await page.getByTestId('directory-add').click();
  await expect(page.getByTestId('directories')).toContainText(info.serversRoot);
  await page.getByTestId('scan').click();
  await expect(page.getByTestId('scan-result')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('server-card')).toHaveCount(1);
  await expect(page.getByTestId('server-card')).toContainText('Vanilla');
  await expect(page.getByTestId('run-state')).toHaveAttribute('data-state', 'stopped');

  // 5. Déconnexion : retour au login, les routes protégées sont à nouveau gardées.
  await page.getByTestId('user-menu').click();
  await page.getByTestId('logout').click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto('/');
  await expect(page).toHaveURL(/\/login\?redirect=/);
});
