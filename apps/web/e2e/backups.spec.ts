/**
 * Phase 8 (doc 07) : onglet Sauvegardes — création à chaud (task suivie en direct, archive avec
 * sha256 vérifiable sur disque), restauration en un clic (backup de sécurité + relance), planning de
 * backup (cron), téléchargement de l'archive (taille exacte) ; planificateur (action programmée).
 * Desktop + mobile, fr + en. Chaque projet nettoie ce qu'il a créé (un seul serveur partagé).
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { expect, test } from '@playwright/test';

import { TEXT, apiLogin, langOf, login, waitForServerState } from './helpers.js';

const BACKUP_TEXT = {
  fr: {
    create: 'Créer une sauvegarde',
    empty: 'Aucune sauvegarde pour ce serveur.',
    manual: 'Manuelle',
    safety: 'Sécurité (avant restauration)',
    ok: 'OK',
    schedule: 'Programmer une action',
    restart: 'Redémarrer',
  },
  en: {
    create: 'Create backup',
    empty: 'No backup for this server.',
    manual: 'Manual',
    safety: 'Safety (before restore)',
    ok: 'OK',
    schedule: 'Schedule an action',
    restart: 'Restart',
  },
} as const;

interface BackupDto {
  id: string;
  status: string;
  kind: string;
  sizeBytes: number | null;
  sha256: string | null;
  archivePath: string | null;
}

test('sauvegarde à chaud, restauration, planning, téléchargement, action programmée', async ({
  page,
}, testInfo) => {
  const lang = langOf(testInfo.project.use.locale);
  const t = TEXT[lang];
  const b = BACKUP_TEXT[lang];

  await login(page, lang);
  const card = page.getByTestId('server-card');
  await expect(card.getByTestId('run-state')).toHaveText(t.stopped);
  await card.getByTestId('server-link').click();
  await expect(page.getByTestId('server-page')).toBeVisible();
  const serverId = (await page.getByTestId('server-page').getAttribute('data-server-id')) ?? '';

  // Démarrage : la sauvegarde sera faite à chaud (save-off / save-all flush / save-on).
  await page.getByTestId('action-start').click();
  await expect(page.getByTestId('run-state')).toHaveText(t.running, { timeout: 30_000 });
  await waitForServerState(page.request, serverId, 'running');

  await page.getByTestId('tab-backups').click();
  await expect(page).toHaveURL(/tab=backups/);
  await expect(page.getByTestId('backups-panel')).toBeVisible();
  await expect(page.getByTestId('backups-empty')).toHaveText(b.empty);

  // Création : modal → task suivie en direct → ligne « OK » avec taille.
  await page.getByTestId('backup-create').click();
  await page.getByTestId('backup-comment').fill(`e2e ${lang}`);
  await page.getByTestId('backup-create-confirm').click();
  const row = page.getByTestId('backups-table').locator('tr[data-status="success"]').first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row).toContainText(b.manual);
  await expect(row).toContainText(`e2e ${lang}`);
  await expect(row).toContainText(b.ok);
  await expect(page.getByTestId('backup-tasks')).toHaveCount(0, { timeout: 15_000 });

  // L'archive existe sur disque et correspond au sha256 annoncé par l'API.
  const listed = (await (await page.request.get(`/api/servers/${serverId}/backups`)).json()) as {
    backups: BackupDto[];
  };
  const found = listed.backups.find((x) => x.status === 'success' && x.kind === 'manual');
  if (found === undefined) throw new Error('manual backup not listed');
  const backup = found;
  const archive = await readFile(backup.archivePath ?? '');
  expect(archive.byteLength).toBe(backup.sizeBytes);
  expect(createHash('sha256').update(archive).digest('hex')).toBe(backup.sha256);

  // Téléchargement via le panel (transfert binaire) : même contenu.
  const download = await page.request.get(`/api/servers/${serverId}/backups/${backup.id}/download`);
  expect(download.status()).toBe(200);
  expect(download.headers()['content-length']).toBe(String(backup.sizeBytes));
  expect((await download.body()).equals(archive)).toBe(true);

  // Restauration en un clic : backup de sécurité (par défaut) et relance → serveur de nouveau
  // « en marche », deux lignes OK (manuelle + sécurité).
  await page.getByTestId(`backup-actions-${backup.id}`).click();
  await page.getByTestId(`backup-restore-${backup.id}`).click();
  await expect(page.getByTestId('restore-safety')).toBeChecked();
  await expect(page.getByTestId('restore-restart')).toBeChecked();
  await page.getByTestId('restore-confirm').click();
  // La task arrête, restaure puis relance : l'arrêt peut être trop bref pour être vu à l'écran ;
  // la preuve est la ligne « sécurité » puis le retour « en marche » (vérifié aussi via l'API).
  await expect(
    page.getByTestId('backups-table').locator('tr[data-status="success"]', { hasText: b.safety }),
  ).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('backup-tasks')).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByTestId('run-state')).toHaveText(t.running, { timeout: 60_000 });
  await waitForServerState(page.request, serverId, 'running');

  // Planning de backup (préréglage quotidien) : poussé à l'agent, listé avec la rotation.
  await page.getByTestId('policy-new').click();
  await page.getByTestId('policy-cron-hour').fill('3');
  await page.getByTestId('policy-save').click();
  const policy = page.getByTestId('backup-policies').locator('[data-testid^="policy-"]').filter({
    hasText: '0 3 * * *',
  });
  await expect(policy.first()).toBeVisible({ timeout: 15_000 });

  // Planificateur : action programmée « redémarrer » tous les jours à 4 h, listée avec sa prochaine
  // occurrence, puis supprimée.
  await page.getByTestId('tab-schedule').click();
  await expect(page.getByTestId('schedule-panel')).toBeVisible();
  await page.getByTestId('schedule-new').click();
  await page.getByTestId('schedule-save').click();
  const schedule = page.getByTestId('schedule-panel').locator('[data-testid^="schedule-"]', {
    hasText: b.restart,
  });
  await expect(schedule.first()).toBeVisible({ timeout: 15_000 });
  await expect(schedule.first()).toContainText('0 4 * * *');

  // Arrêt depuis l'UI (état initial pour les projets suivants) ; le reste du nettoyage est en afterEach.
  await page.getByTestId('action-stop').click();
  await expect(page.getByTestId('run-state')).toHaveText(t.stopped, { timeout: 30_000 });
  await waitForServerState(page.request, serverId, 'stopped');
});

/** Nettoyage via l'API, même si le test a échoué en route (un seul serveur partagé entre projets). */
test.afterEach(async ({ request }) => {
  await apiLogin(request);
  const servers = (await (await request.get('/api/servers')).json()) as {
    servers: { id: string; runState: string }[];
  };
  for (const server of servers.servers) {
    const schedules = (await (await request.get(`/api/servers/${server.id}/schedules`)).json()) as {
      schedules: { id: string }[];
    };
    for (const s of schedules.schedules) {
      await request.delete(`/api/servers/${server.id}/schedules/${s.id}`);
    }
    const after = (await (await request.get(`/api/servers/${server.id}/backups`)).json()) as {
      backups: BackupDto[];
      policies: { id: string }[];
    };
    for (const p of after.policies) {
      await request.delete(`/api/servers/${server.id}/backup-policies/${p.id}`);
    }
    for (const x of after.backups) {
      if (x.status === 'success') await request.delete(`/api/servers/${server.id}/backups/${x.id}`);
    }
    if (server.runState !== 'stopped') {
      await request.post(`/api/servers/${server.id}/stop`, { data: {} });
      await waitForServerState(request, server.id, 'stopped');
    }
  }
});
