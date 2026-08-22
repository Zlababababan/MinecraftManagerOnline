/**
 * Critère « terminé quand » de la phase 6 (doc 07) : gérer une whitelist depuis un téléphone
 * **sans jamais voir un fichier**, serveur arrêté (l'agent édite whitelist.json) puis en marche
 * (l'agent envoie `whitelist add/remove` ; le serveur réécrit le fichier). Joué desktop + mobile,
 * fr + en. Le fichier sur disque est vérifié depuis le test (jamais depuis l'UI).
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { TEXT, langOf, login, waitForServerState } from './helpers.js';

const WHITELIST_TEXT = {
  fr: {
    off: 'Liste blanche désactivée',
    on: 'Liste blanche activée',
    offlineHint: 'mode hors ligne',
  },
  en: {
    off: 'Whitelist disabled',
    on: 'Whitelist enabled',
    offlineHint: 'offline-mode',
  },
} as const;

async function readWhitelist(serverDir: string): Promise<{ name: string; uuid: string }[]> {
  try {
    return JSON.parse(await readFile(path.join(serverDir, 'whitelist.json'), 'utf8')) as {
      name: string;
      uuid: string;
    }[];
  } catch {
    return [];
  }
}

async function addToWhitelist(page: Page, name: string): Promise<void> {
  await page.getByTestId('whitelist-add-name').fill(name);
  await page.getByTestId('whitelist-add-submit').click();
  await expect(page.getByTestId(`whitelist-${name}`)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('whitelist-add-resolved')).toBeVisible();
}

/** Le Switch Mantine cache son input : on clique sur la piste (label for=id). */
async function toggleWhitelist(page: Page): Promise<void> {
  const id = await page.getByTestId('whitelist-toggle').getAttribute('id');
  await page
    .locator(`label[for="${id ?? ''}"]`)
    .first()
    .click();
}

async function removeFromWhitelist(page: Page, name: string): Promise<void> {
  await page.getByTestId(`whitelist-${name}`).getByTestId(`remove-${name}`).click();
  await page.getByTestId('confirm-remove').click();
  await expect(page.getByTestId(`whitelist-${name}`)).toBeHidden({ timeout: 20_000 });
}

test('gérer la whitelist sans jamais voir un fichier — serveur arrêté puis en marche', async ({
  page,
  isMobile,
}, testInfo) => {
  const lang = langOf(testInfo.project.use.locale);
  const t = TEXT[lang];
  const w = WHITELIST_TEXT[lang];
  const info = (await (await page.request.get('/e2e/info')).json()) as { serverDir: string };
  const visitedTabs = new Set<string>();
  page.on('framenavigated', (frame) => {
    const tab = new URL(frame.url()).searchParams.get('tab');
    if (tab !== null) visitedTabs.add(tab);
  });

  await login(page, lang);
  const card = page.getByTestId('server-card');
  await expect(card.getByTestId('run-state')).toHaveText(t.stopped);
  await card.getByTestId('server-link').click();
  await expect(page.getByTestId('server-page')).toBeVisible();
  const serverId = (await page.getByTestId('server-page').getAttribute('data-server-id')) ?? '';
  expect(serverId).not.toBe('');

  // Onglet Joueurs → vue Liste blanche (sur mobile, les onglets défilent horizontalement).
  await page.getByTestId('tab-players').click();
  await expect(page).toHaveURL(/tab=players/);
  await page.getByTestId('players-view-whitelist').click();
  await expect(page.getByTestId('whitelist')).toBeVisible();
  await expect(page.getByTestId('whitelist-status')).toContainText(w.off);
  if (isMobile) await expect(page.getByTestId('bottom-nav')).toBeVisible();

  // 1. Serveur arrêté : l'agent écrit whitelist.json (UUID hors ligne, online-mode=false).
  const alice = `Alice${testInfo.project.name.replace(/[^a-z]/gi, '').slice(0, 6)}`;
  await addToWhitelist(page, alice);
  await expect(page.getByTestId('whitelist-add-resolved')).toContainText(w.offlineHint);
  await expect
    .poll(async () => (await readWhitelist(info.serverDir)).map((e) => e.name))
    .toContain(alice);

  // 2. Démarrage depuis l'en-tête → en marche : l'agent passe en commandes.
  await page.getByTestId('action-start').click();
  await expect(page.getByTestId('run-state')).toHaveText(t.running, { timeout: 30_000 });
  await waitForServerState(page.request, serverId, 'running');
  await addToWhitelist(page, 'Bob');
  // Le fake server a réécrit le fichier lui-même (`whitelist add Bob`).
  await expect
    .poll(async () => (await readWhitelist(info.serverDir)).map((e) => e.name).sort())
    .toEqual([alice, 'Bob'].sort());
  await removeFromWhitelist(page, alice);
  await expect
    .poll(async () => (await readWhitelist(info.serverDir)).map((e) => e.name))
    .toEqual(['Bob']);

  // 3. Activation de la liste blanche à chaud (server.properties + `whitelist on`).
  await toggleWhitelist(page);
  await expect(page.getByTestId('whitelist-status')).toContainText(w.on, { timeout: 20_000 });
  await expect
    .poll(async () => readFile(path.join(info.serverDir, 'server.properties'), 'utf8'))
    .toContain('white-list=true');

  // 4. Retrait en marche, puis arrêt : retour à l'état initial pour les projets suivants.
  await removeFromWhitelist(page, 'Bob');
  await toggleWhitelist(page);
  await expect(page.getByTestId('whitelist-status')).toContainText(w.off, { timeout: 20_000 });
  await page.getByTestId('action-stop').click();
  await expect(page.getByTestId('run-state')).toHaveText(t.stopped, { timeout: 30_000 });
  await waitForServerState(page.request, serverId, 'stopped');
  await expect.poll(async () => readWhitelist(info.serverDir)).toEqual([]);

  // Jamais un fichier : ni l'onglet Fichiers ni l'onglet Configuration n'ont été ouverts.
  expect([...visitedTabs].filter((tab) => tab !== 'players')).toEqual([]);
  await expect(page).toHaveURL(/tab=players/);
  await expect(page.getByTestId('file-explorer')).toHaveCount(0);
});
