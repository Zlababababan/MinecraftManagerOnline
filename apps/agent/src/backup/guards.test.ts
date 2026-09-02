/**
 * Lot 4 — gardes AVANT d'écrire une archive, sur de VRAIS fichiers : espace disque estimé (taux de
 * compression de la dernière archive du serveur, marge fixe), marqueur d'une destination explicite
 * (absent → refus sans rien créer ; présent, même vide → accepté ; destination par défaut → jamais
 * exigé), dépôt du marqueur à la configuration (destination nouvelle seulement ; retirée puis
 * remise = marquée à nouveau ; dossier impossible à écrire = signalé, pas mémorisé), et `save-on`
 * toujours renvoyé au serveur après un refus.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ProtocolError, type BackupManifest } from '@mmo/protocol';
import { createI18n, translateError } from '@mmo/shared';

import { Logger } from '../log.js';
import type { TaskContext } from '../tasks/runner.js';
import { tmpDir } from '../test/helpers.js';
import { BackupService } from './backup-service.js';
import {
  DESTINATION_MARKER,
  SPACE_HEADROOM_BYTES,
  estimateArchiveBytes,
  hasMarker,
  markerPath,
} from './guards.js';

const T0 = Date.UTC(2026, 8, 2, 4, 0, 0);
const PROPERTIES = 'motd=Survie\n';
const REGION_BYTES = 300_000;
/** Tout ce que l'inventaire compte : la région ET server.properties. */
const RAW_BYTES = REGION_BYTES + PROPERTIES.length;
const logger = new Logger('test', { stderr: false });

interface Harness {
  dir: string;
  cleanup: () => Promise<void>;
  serverDir: string;
  state: {
    servers: Record<string, { config: { path: string } }>;
    backupSchedules: { id: string; serverId: string; cron: string; destination?: string }[];
    backupDestination: string | undefined;
    markedDestinations: string[];
  };
  /** Espace libre rapporté par la sonde (`undefined` = non mesurable). */
  free: number | undefined;
  /** Serveur « en marche » : `save-off` / `save-all flush` / `save-on` passent par ici. */
  hot: boolean;
  commands: string[];
  now: number;
  backups: BackupService;
}

async function build(): Promise<Harness> {
  const { dir, cleanup } = await tmpDir('mmo-guards-');
  const serverDir = path.join(dir, 'Survie');
  await mkdir(path.join(serverDir, 'world', 'region'), { recursive: true });
  await writeFile(path.join(serverDir, 'server.properties'), PROPERTIES);
  // Octets aléatoires : incompressibles, donc `bytesRaw` est aussi la taille réelle de l'archive.
  await writeFile(path.join(serverDir, 'world', 'region', 'r.0.0.mca'), randomBytes(REGION_BYTES));
  const h: Harness = {
    dir,
    cleanup,
    serverDir,
    state: {
      servers: { srv_1: { config: { path: serverDir } } },
      backupSchedules: [],
      backupDestination: undefined,
      markedDestinations: [],
    },
    free: undefined,
    hot: false,
    commands: [],
    now: T0,
    backups: undefined as unknown as BackupService,
  };
  const proc = {
    isRunning: true,
    state: 'running',
    rcon: undefined,
    buffer: { latestSeq: 0, since: () => ({ lines: [{ text: '[Server] Saved the game' }] }) },
    sendCommand: (command: string) => {
      h.commands.push(command);
      return Promise.resolve();
    },
  };
  h.backups = new BackupService({
    stateDir: dir,
    store: {
      get: () => h.state,
      getServer: (id: string) => h.state.servers[id],
      update: (fn: (s: typeof h.state) => void) => {
        fn(h.state);
        return Promise.resolve();
      },
    } as never,
    manager: { get: () => (h.hot ? proc : undefined) } as never,
    logger,
    agentVersion: 'test',
    now: () => h.now,
    onRotated: () => undefined,
    freeBytes: () => Promise.resolve(h.free),
  });
  return h;
}

function ctx(): TaskContext {
  return {
    taskId: 'task_1',
    signal: new AbortController().signal,
    isCancelled: false,
    throwIfCancelled: () => undefined,
    progress: () => undefined,
    artifact: () => undefined,
    keep: () => undefined,
    checkpoint: () => Promise.resolve(),
  };
}

async function refusal(run: Promise<unknown>): Promise<ProtocolError> {
  try {
    await run;
  } catch (error) {
    if (error instanceof ProtocolError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

describe('estimateArchiveBytes — taille prévue d’une archive', () => {
  it('sans historique : 1:1 (pessimiste) plus la marge', () => {
    expect(estimateArchiveBytes(1000, [])).toEqual({
      requiredBytes: 1000 + SPACE_HEADROOM_BYTES,
      ratio: 1,
      basedOn: undefined,
    });
  });

  it('avec historique : le taux de la plus récente, quel que soit l’ordre du tableau', () => {
    const history = [
      { backupId: 'bk_new', createdAt: 20, bytesRaw: 1000, sizeBytes: 500 },
      { backupId: 'bk_old', createdAt: 10, bytesRaw: 1000, sizeBytes: 900 },
    ];
    expect(estimateArchiveBytes(1000, history)).toEqual({
      requiredBytes: 500 + SPACE_HEADROOM_BYTES,
      ratio: 0.5,
      basedOn: 'bk_new',
    });
    expect(estimateArchiveBytes(1000, [...history].reverse()).basedOn).toBe('bk_new');
  });

  it('taux borné : jamais plus de 1, jamais moins que le plancher ; archives vides ignorées', () => {
    expect(
      estimateArchiveBytes(1000, [
        { backupId: 'bk_fat', createdAt: 1, bytesRaw: 100, sizeBytes: 300 },
      ]).ratio,
    ).toBe(1);
    expect(
      estimateArchiveBytes(1000, [
        { backupId: 'bk_zero', createdAt: 1, bytesRaw: 100, sizeBytes: 0 },
      ]).ratio,
    ).toBe(0.05);
    expect(
      estimateArchiveBytes(1000, [
        { backupId: 'bk_empty', createdAt: 5, bytesRaw: 0, sizeBytes: 0 },
        { backupId: 'bk_ok', createdAt: 1, bytesRaw: 100, sizeBytes: 50 },
      ]).basedOn,
    ).toBe('bk_ok');
  });
});

describe('BackupService — gardes avant écriture, sur de vrais fichiers', () => {
  let h: Harness;
  const cleanups: (() => Promise<void>)[] = [];

  beforeEach(async () => {
    h = await build();
    cleanups.push(h.cleanup);
  });
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  it('espace insuffisant : refus avant le premier octet, nombres actionnables, save-on rétabli', async () => {
    h.hot = true;
    h.free = 1000;
    const error = await refusal(
      h.backups.create({ serverId: 'srv_1', kind: 'manual', backupId: 'bk_1' }, ctx()),
    );
    expect(error.code).toBe('E_IO');
    expect(error.retryable).toBe(false);
    expect(error.details).toMatchObject({
      reason: 'INSUFFICIENT_SPACE',
      freeBytes: 1000,
      freeMb: 1,
      bytesRaw: RAW_BYTES,
      ratio: 1,
    });
    expect(error.details?.requiredBytes).toBe(RAW_BYTES + SPACE_HEADROOM_BYTES);
    expect(error.details?.path).toBe(path.join(h.dir, 'backups', 'srv_1'));
    // La traduction porte les nombres : c'est ce que l'utilisateur lit dans la fiche de sauvegarde.
    const message = translateError(createI18n('en'), {
      code: error.code,
      details: error.details,
    });
    expect(message).toContain('65 MB needed');
    expect(message).toContain('1 MB free');
    // Rien d'écrit : ni `.part`, ni archive, ni manifeste.
    expect(await readdir(path.join(h.dir, 'backups', 'srv_1'))).toEqual([]);
    // Le serveur n'est pas laissé avec l'écriture du monde désactivée.
    expect(h.commands).toEqual(['save-off', 'save-all flush', 'save-on']);
  });

  it('la marge compte : l’espace exactement égal aux octets bruts est refusé, au-delà de la marge accepté', async () => {
    h.free = RAW_BYTES;
    const error = await refusal(
      h.backups.create({ serverId: 'srv_1', kind: 'manual', backupId: 'bk_tight' }, ctx()),
    );
    expect(error.details?.reason).toBe('INSUFFICIENT_SPACE');

    h.free = RAW_BYTES + SPACE_HEADROOM_BYTES + 1;
    const manifest = await h.backups.create(
      { serverId: 'srv_1', kind: 'manual', backupId: 'bk_fits' },
      ctx(),
    );
    expect(await exists(manifest.archivePath)).toBe(true);
    expect(manifest.bytesRaw).toBe(RAW_BYTES);
  });

  it('estime avec le taux de compression de la dernière archive du serveur', async () => {
    // Archive de référence compressée à 50 % (manifeste synthétique, archive présente).
    const destDir = path.join(h.dir, 'backups', 'srv_1');
    await mkdir(destDir, { recursive: true });
    const reference: BackupManifest = {
      backupId: 'bk_ref',
      serverId: 'srv_1',
      kind: 'manual',
      createdAt: h.now + 1,
      codec: 'gzip',
      archivePath: path.join(destDir, 'bk_ref.tar.gz'),
      sizeBytes: RAW_BYTES / 2,
      sha256: 'a'.repeat(64),
      files: 1,
      bytesRaw: RAW_BYTES,
      hot: false,
    };
    await writeFile(reference.archivePath, 'x');
    await writeFile(path.join(destDir, 'bk_ref.json'), JSON.stringify(reference));

    h.free = Math.round(RAW_BYTES * 0.4) + SPACE_HEADROOM_BYTES;
    const error = await refusal(
      h.backups.create({ serverId: 'srv_1', kind: 'manual', backupId: 'bk_2' }, ctx()),
    );
    expect(error.details).toMatchObject({
      reason: 'INSUFFICIENT_SPACE',
      ratio: 0.5,
      basedOn: 'bk_ref',
      requiredBytes: RAW_BYTES / 2 + SPACE_HEADROOM_BYTES,
    });

    // Sans le taux mesuré, 60 % des octets bruts auraient été refusés (1:1 + marge).
    h.free = Math.round(RAW_BYTES * 0.6) + SPACE_HEADROOM_BYTES;
    const manifest = await h.backups.create(
      { serverId: 'srv_1', kind: 'manual', backupId: 'bk_3' },
      ctx(),
    );
    expect(await exists(manifest.archivePath)).toBe(true);
  });

  it('sonde muette : aucune garde inventée', async () => {
    h.free = undefined;
    const manifest = await h.backups.create(
      { serverId: 'srv_1', kind: 'manual', backupId: 'bk_blind' },
      ctx(),
    );
    expect(await exists(manifest.archivePath)).toBe(true);
  });

  it('destination explicite sans marqueur : refusée sans rien créer ; marqueur présent (même vide) : acceptée', async () => {
    const destA = path.join(h.dir, 'nas', 'mmo');
    h.state.backupDestination = destA;
    const error = await refusal(
      h.backups.create({ serverId: 'srv_1', kind: 'manual', backupId: 'bk_a' }, ctx()),
    );
    expect(error.code).toBe('E_IO');
    expect(error.retryable).toBe(false);
    expect(error.details).toEqual({
      reason: 'DESTINATION_UNMARKED',
      path: path.resolve(destA),
      marker: DESTINATION_MARKER,
    });
    // Le point de montage « vide » n'a même pas été créé : rien n'y est apparu.
    expect(await exists(destA)).toBe(false);
    expect(
      translateError(createI18n('fr'), { code: error.code, details: error.details }),
    ).toContain(DESTINATION_MARKER);

    // Un fichier vide créé à la main vaut marqueur.
    await mkdir(destA, { recursive: true });
    await writeFile(markerPath(destA), '');
    const manifest = await h.backups.create(
      { serverId: 'srv_1', kind: 'manual', backupId: 'bk_a2' },
      ctx(),
    );
    expect(manifest.archivePath.startsWith(path.join(path.resolve(destA), 'srv_1'))).toBe(true);

    // Destination portée par la requête (planning) : même règle, indépendamment du réglage global.
    const destB = path.join(h.dir, 'usb');
    await mkdir(destB, { recursive: true });
    const refused = await refusal(
      h.backups.create(
        { serverId: 'srv_1', kind: 'scheduled', backupId: 'bk_b', destination: destB },
        ctx(),
      ),
    );
    expect(refused.details?.path).toBe(path.resolve(destB));
    expect(await readdir(destB)).toEqual([]);
  });

  it('la destination par défaut (dossier de l’agent) n’exige aucun marqueur', async () => {
    const manifest = await h.backups.create(
      { serverId: 'srv_1', kind: 'manual', backupId: 'bk_default' },
      ctx(),
    );
    expect(manifest.archivePath.startsWith(path.join(h.dir, 'backups', 'srv_1'))).toBe(true);
    expect(await hasMarker(path.join(h.dir, 'backups'))).toBe(false);
  });

  it('markNewDestinations : nouvelle destination marquée, jamais remarquée tant qu’elle reste configurée, retirée puis remise = marquée à nouveau', async () => {
    const destA = path.join(h.dir, 'nas', 'a');
    const destB = path.join(h.dir, 'nas', 'b');
    h.state.backupDestination = destA;
    expect(await h.backups.markNewDestinations()).toEqual({
      marked: [path.resolve(destA)],
      failed: [],
    });
    expect(await hasMarker(destA)).toBe(true);
    expect(h.state.markedDestinations).toEqual([path.resolve(destA)]);

    // « Volume démonté » : le marqueur a disparu. Une configuration inchangée ne le recrée PAS —
    // c'est la sauvegarde suivante qui doit échouer.
    await rm(markerPath(destA));
    expect(await h.backups.markNewDestinations()).toEqual({ marked: [], failed: [] });
    expect(await hasMarker(destA)).toBe(false);

    // Une destination de planning nouvelle est marquée ; A reste telle quelle.
    h.state.backupSchedules = [
      { id: 'pol_1', serverId: 'srv_1', cron: '0 4 * * *', destination: destB },
    ];
    expect((await h.backups.markNewDestinations()).marked).toEqual([path.resolve(destB)]);
    expect(await hasMarker(destB)).toBe(true);
    expect(await hasMarker(destA)).toBe(false);
    expect(h.state.markedDestinations).toEqual([path.resolve(destA), path.resolve(destB)]);

    // A retirée des réglages : oubliée. Remise : marquée à nouveau (le geste documenté).
    h.state.backupDestination = undefined;
    expect((await h.backups.markNewDestinations()).marked).toEqual([]);
    expect(h.state.markedDestinations).toEqual([path.resolve(destB)]);
    h.state.backupDestination = destA;
    expect((await h.backups.markNewDestinations()).marked).toEqual([path.resolve(destA)]);
    expect(await hasMarker(destA)).toBe(true);

    // Un marqueur déjà présent (autre agent du parc, fichier créé à la main) est conservé tel quel.
    h.state.backupDestination = undefined;
    await h.backups.markNewDestinations();
    await writeFile(markerPath(destA), 'hand-made');
    h.state.backupDestination = destA;
    await h.backups.markNewDestinations();
    expect(await readdir(destA)).toEqual([DESTINATION_MARKER]);
    expect(
      await import('node:fs/promises').then((fs) => fs.readFile(markerPath(destA), 'utf8')),
    ).toBe('hand-made');
  });

  it('markNewDestinations : un dossier impossible à écrire est signalé et non mémorisé (réessayé à la configuration suivante)', async () => {
    const file = path.join(h.dir, 'not-a-dir');
    await writeFile(file, 'x');
    const impossible = path.join(file, 'backups');
    h.state.backupDestination = impossible;
    const result = await h.backups.markNewDestinations();
    expect(result.marked).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.path).toBe(path.resolve(impossible));
    expect(h.state.markedDestinations).toEqual([]);
  });
});
