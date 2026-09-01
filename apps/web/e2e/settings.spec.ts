/**
 * Phase 12 (doc 07) : thèmes, notifications (phase 10) et Réglages admin (phases 10–11), joués
 * desktop + mobile, fr + en, contre le panel réel + agent réel + fake Java server.
 * - thème : menu d'en-tête → clair/sombre/système (suit le navigateur), persistant (serveur + rechargement) ;
 * - notifications : préférence « état des serveurs » activée → démarrage → cloche → centre → tout lu,
 *   puis préférence désactivée → arrêt sans notification ;
 * - Réglages : URL publique, test de joignabilité réel (HTTP + WebSocket + frame binaire via
 *   `/ws/probe`), distribution factice déposée par l'API admin → carte (version, plateformes,
 *   one-liners) → effacement.
 */
import { createHash } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';

import { langOf, login, waitForServerState } from './helpers.js';

const html = (page: Page) => page.locator('html');

async function pickTheme(page: Page, theme: 'light' | 'dark' | 'auto'): Promise<void> {
  await page.getByTestId('theme-menu').click();
  await page.getByTestId(`theme-${theme}`).click();
}

async function userTheme(page: Page): Promise<string> {
  const res = await page.request.get('/api/auth/me');
  expect(res.ok()).toBeTruthy();
  return ((await res.json()) as { user: { theme: string } }).user.theme;
}

async function unreadCount(page: Page): Promise<number> {
  const res = await page.request.get('/api/notifications');
  expect(res.ok()).toBeTruthy();
  return ((await res.json()) as { unread: number }).unread;
}

async function prefServerState(page: Page): Promise<boolean> {
  const res = await page.request.get('/api/notifications/prefs');
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as {
    channels: Record<string, Record<string, boolean>>;
  };
  // Depuis les 21 catégories, la cloche du panel (canal inapp) et le téléphone (push) se règlent
  // séparément : c'est la cloche que ce test observe.
  return body.channels.inapp?.['server.state'] ?? false;
}

/** Le Switch Mantine cache son input : on clique sur la piste (label for=id). */
async function toggleSwitch(page: Page, testId: string): Promise<void> {
  const id = await page.getByTestId(testId).getAttribute('id');
  await page
    .locator(`label[for="${id ?? ''}"]`)
    .first()
    .click();
}

test('thème : clair, sombre, système (suit le navigateur), persistant après rechargement', async ({
  page,
}, testInfo) => {
  const lang = langOf(testInfo.project.use.locale);
  await login(page, lang);
  await expect(html(page)).toHaveAttribute('data-mantine-color-scheme', 'dark');

  await pickTheme(page, 'light');
  await expect(html(page)).toHaveAttribute('data-mantine-color-scheme', 'light');
  await expect.poll(() => userTheme(page)).toBe('light');
  await page.reload();
  await expect(page.getByTestId('dashboard')).toBeVisible();
  await expect(html(page)).toHaveAttribute('data-mantine-color-scheme', 'light');

  await page.emulateMedia({ colorScheme: 'dark' });
  await pickTheme(page, 'auto');
  await expect(html(page)).toHaveAttribute('data-mantine-color-scheme', 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(html(page)).toHaveAttribute('data-mantine-color-scheme', 'light');
  await expect.poll(() => userTheme(page)).toBe('auto');

  await pickTheme(page, 'dark');
  await expect(html(page)).toHaveAttribute('data-mantine-color-scheme', 'dark');
  await expect.poll(() => userTheme(page)).toBe('dark');
});

test('notifications : préférence activée → démarrage → cloche → centre → lu ; désactivée → silence', async ({
  page,
}, testInfo) => {
  const lang = langOf(testInfo.project.use.locale);
  await login(page, lang);
  await page.goto('/account');
  await expect(page.getByTestId('account-page')).toBeVisible();
  const pref = page.getByTestId('pref-inapp-server.state');
  await expect(pref).toBeEnabled();
  await expect(pref).not.toBeChecked();
  await toggleSwitch(page, 'pref-inapp-server.state');
  await expect(pref).toBeChecked();
  await expect.poll(() => prefServerState(page)).toBe(true);

  // Point de départ propre quel que soit le projet joué avant : le centre est une vue filtrée des
  // événements par les préférences courantes → tout marquer lu **après** l'activation.
  const list = await page.request.get('/api/notifications');
  const { notifications: items } = (await list.json()) as { notifications: { id: number }[] };
  if (items.length > 0) {
    const seen = await page.request.post('/api/notifications/seen', {
      data: { id: Math.max(...items.map((i) => i.id)) },
    });
    expect(seen.ok()).toBeTruthy();
  }
  await page.reload();
  await expect(page.getByTestId('account-page')).toBeVisible();
  const indicator = page.getByTestId('notifications-indicator');
  await expect.poll(() => unreadCount(page)).toBe(0);
  await expect(indicator).toHaveAttribute('data-unread', '0');

  const res = await page.request.get('/api/servers');
  const { servers } = (await res.json()) as { servers: { id: string; name: string }[] };
  const server = servers[0];
  expect(server).toBeDefined();
  if (!server) return;
  expect((await page.request.post(`/api/servers/${server.id}/start`, { data: {} })).ok()).toBe(
    true,
  );
  await waitForServerState(page.request, server.id, 'running');

  await expect(indicator).toHaveAttribute('data-unread', '1', { timeout: 20_000 });
  await page.getByTestId('notifications-open').click();
  await expect(page.getByTestId('notifications-unread')).toBeVisible();
  // Entrée du centre : type traduit + état + nom du serveur.
  const entry = page.locator('button[data-testid^="notification-"]').first();
  await expect(entry).toBeVisible();
  await expect(entry).toContainText(server.name);
  await expect(entry).toContainText(lang === 'fr' ? 'En marche' : 'Running');
  await page.getByTestId('notifications-mark-seen').click();
  await expect(indicator).toHaveAttribute('data-unread', '0');

  // Préférence désactivée : l'arrêt ne notifie plus.
  await page.goto('/account');
  await expect(pref).toBeChecked();
  await toggleSwitch(page, 'pref-inapp-server.state');
  await expect(pref).not.toBeChecked();
  await expect.poll(() => prefServerState(page)).toBe(false);
  expect((await page.request.post(`/api/servers/${server.id}/stop`, { data: {} })).ok()).toBe(true);
  await waitForServerState(page.request, server.id, 'stopped');
  await page.waitForTimeout(1500);
  expect(await unreadCount(page)).toBe(0);
  await expect(indicator).toHaveAttribute('data-unread', '0');
});

test('Réglages : URL publique, test de joignabilité réel, distribution déposée puis effacée', async ({
  page,
  baseURL,
}, testInfo) => {
  const lang = langOf(testInfo.project.use.locale);
  await login(page, lang);
  await page.goto('/settings');
  await expect(page.getByTestId('settings-page')).toBeVisible();

  // URL publique (injectée dans les one-liners et les notifications push).
  const publicUrl = baseURL ?? 'http://127.0.0.1:3999';
  await page.getByTestId('settings-public-url').fill(publicUrl);
  await page.getByTestId('settings-general-save').click();
  await page.reload();
  await expect(page.getByTestId('settings-public-url')).toHaveValue(publicUrl);

  // Joignabilité : HTTP + WebSocket + frame binaire de 64 KiB via /ws/probe (TLS sans objet en http).
  await expect(page.getByTestId('access-test-url')).toHaveValue(publicUrl);
  await page.getByTestId('access-test-run').click();
  const result = page.getByTestId('access-test-result');
  await expect(result).toBeVisible({ timeout: 30_000 });
  await expect(result).toHaveAttribute('data-ok', 'true');
  await expect(result).toContainText(publicUrl);

  // Distribution : vide, puis dépôt factice par l'API admin (fichiers + manifeste vérifiés).
  await expect(page.getByTestId('distribution-empty')).toBeVisible();
  const version = '0.0.1-e2e';
  const bundle = Buffer.from(`// fake agent bundle ${version}\n`);
  const archive = Buffer.from(`PK fake archive ${version}`);
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
  const put = async (name: string, body: Buffer) => {
    const r = await page.request.put(`/api/admin/dist/files/${name}`, {
      data: body,
      headers: { 'content-type': 'application/octet-stream' },
    });
    expect(r.ok()).toBeTruthy();
  };
  await put(`agent-${version}.js`, bundle);
  await put(`mmo-agent-${version}-win-x64.zip`, archive);
  const manifest = await page.request.put('/api/admin/dist/manifest', {
    data: {
      version,
      protocolVersion: 1,
      runtimeVersion: '24.19.0',
      builtAt: Date.now(),
      signingKey: 'dev',
      bundle: {
        file: `agent-${version}.js`,
        sha256: sha(bundle),
        size: bundle.length,
        signature: 'c2ln',
      },
      platforms: {
        'win-x64': {
          file: `mmo-agent-${version}-win-x64.zip`,
          sha256: sha(archive),
          size: archive.length,
        },
      },
    },
  });
  expect(manifest.ok()).toBeTruthy();
  await page.reload();
  await expect(page.getByTestId('distribution-version')).toContainText(version);
  await expect(page.getByTestId('distribution-release')).toBeVisible();
  await expect(page.getByTestId('distribution-dev-key')).toBeVisible();
  await expect(page.getByTestId('dist-platform-win-x64')).toHaveAttribute('data-available', 'true');
  await expect(page.getByTestId('dist-platform-linux-x64')).toHaveAttribute(
    'data-available',
    'false',
  );
  await expect(page.getByTestId('dist-oneliner-windows')).toContainText(`${publicUrl}/install.ps1`);
  await expect(page.getByTestId('dist-oneliner-unix')).toContainText(`${publicUrl}/install.sh`);
  // L'archive et le script sont servis publiquement, avec l'empreinte annoncée.
  const dl = await page.request.get(`/dist/mmo-agent-${version}-win-x64.zip`);
  expect(dl.ok()).toBeTruthy();
  expect(dl.headers()['x-sha256']).toBe(sha(archive));
  const script = await page.request.get('/install.ps1');
  expect(await script.text()).toContain(`[string]$Panel = '${publicUrl}'`);

  page.once('dialog', (dialog) => {
    void dialog.accept();
  });
  await page.getByTestId('distribution-clear').click();
  await expect(page.getByTestId('distribution-empty')).toBeVisible();
});

test('Réglages : sauvegarde du panel à la demande (VACUUM INTO) listée avec sa taille', async ({
  page,
}, testInfo) => {
  await login(page, langOf(testInfo.project.use.locale));
  await page.goto('/settings');
  const card = page.getByTestId('panel-backups-card');
  await expect(card).toBeVisible();
  await page.getByTestId('panel-backup-now').click();
  const table = page.getByTestId('panel-backups-table');
  await expect(table).toBeVisible();
  await expect(table.locator('tbody tr').first()).toContainText(/mmo-.*\.db/);
  // La commande de restauration cite le fichier le plus récent.
  await expect(card).toContainText(/mmo-panel restore mmo-.*\.db/);
});
