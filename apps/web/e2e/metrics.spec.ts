/**
 * Phase 7 (doc 07) : l'onglet Métriques se remplit en direct une fois le serveur lancé (CPU/RSS par
 * cycles, joueurs), la résolution est annoncée, et le TPS indisponible (vanilla 1.20.1 : aucune
 * méthode honnête) est dit franchement — jamais une valeur inventée. Desktop + mobile, fr + en.
 */
import { expect, test } from '@playwright/test';

import { TEXT, langOf, login, waitForServerState } from './helpers.js';

const METRICS_TEXT = {
  fr: {
    raw: 'Échantillons bruts',
    tpsUnavailable: 'TPS indisponible',
    vanilla: 'antérieur à 1.20.3',
  },
  en: { raw: 'Raw samples', tpsUnavailable: 'TPS unavailable', vanilla: 'before 1.20.3' },
} as const;

test('graphiques en direct et TPS honnête', async ({ page }, testInfo) => {
  const lang = langOf(testInfo.project.use.locale);
  const t = TEXT[lang];
  const m = METRICS_TEXT[lang];

  await login(page, lang);
  const card = page.getByTestId('server-card');
  await expect(card.getByTestId('run-state')).toHaveText(t.stopped);
  await card.getByTestId('server-link').click();
  await expect(page.getByTestId('server-page')).toBeVisible();
  const serverId = (await page.getByTestId('server-page').getAttribute('data-server-id')) ?? '';

  await page.getByTestId('tab-metrics').click();
  await expect(page).toHaveURL(/tab=metrics/);
  await expect(page.getByTestId('metrics-panel')).toBeVisible();
  await expect(page.getByTestId('metrics-resolution')).toContainText(m.raw);
  // Serveur arrêté : pas d'alerte TPS (rien à mesurer), graphiques présents.
  await expect(page.getByTestId('tps-unavailable')).toHaveCount(0);
  await expect(page.getByTestId('chart-cpu')).toBeVisible();

  // Démarrage → échantillons toutes les secondes (fixture) : joueurs = 1 (Alice), RSS mesuré.
  await page.getByTestId('action-start').click();
  await expect(page.getByTestId('run-state')).toHaveText(t.running, { timeout: 30_000 });
  await waitForServerState(page.request, serverId, 'running');
  await expect
    .poll(
      async () => {
        const res = await page.request.get(
          `/api/servers/${serverId}/metrics?from=${String(Date.now() - 600_000)}`,
        );
        const body = (await res.json()) as {
          latest: { players: number | null; ram: number | null } | null;
        };
        return body.latest?.players === 1 && (body.latest.ram ?? 0) > 0;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  // Le point arrive en direct (WebSocket) : la ligne des joueurs est tracée, « maintenant » affiche 1.
  await expect(page.getByTestId('series-players').locator('path[fill="none"]')).toHaveAttribute(
    'd',
    /M/,
    {
      timeout: 20_000,
    },
  );
  // TPS : vanilla 1.20.1 ⇒ aucune méthode honnête, dit franchement (jamais une valeur inventée).
  const alert = page.getByTestId('tps-unavailable');
  await expect(alert).toBeVisible({ timeout: 20_000 });
  await expect(alert).toContainText(m.tpsUnavailable);
  await expect(alert).toContainText(m.vanilla);

  // Plage 24 h : résolution annoncée différemment, toujours sans erreur.
  // SegmentedControl Mantine : l'input radio est caché, on clique son label (comme le Switch, piège 8).
  await page.getByTestId('metrics-range').locator('label', { hasText: '24 h' }).click();
  await expect(page.getByTestId('metrics-resolution')).not.toContainText(m.raw, {
    timeout: 15_000,
  });

  // Arrêt : retour à l'état initial pour les projets suivants.
  await page.getByTestId('action-stop').click();
  await expect(page.getByTestId('run-state')).toHaveText(t.stopped, { timeout: 30_000 });
  await waitForServerState(page.request, serverId, 'stopped');
});
