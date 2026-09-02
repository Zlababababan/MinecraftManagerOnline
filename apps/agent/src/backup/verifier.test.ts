/**
 * Lot 4 — vérification périodique des archives, sur de VRAIS fichiers : ordre (jamais vérifiées,
 * les plus anciennes d'abord), manifeste réinscrit, archive altérée déclarée corrompue et jamais
 * relue, serveur occupé laissé de côté, budget d'octets, cadence quotidienne et délai initial.
 */
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { BackupManifest } from '@mmo/protocol';

import { Logger } from '../log.js';
import { tmpDir } from '../test/helpers.js';
import { BackupService, type BackupVerification } from './backup-service.js';
import { BackupVerifier, selectForVerification } from './verifier.js';

const T0 = Date.UTC(2026, 8, 2, 1, 0, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const logger = new Logger('test', { stderr: false });

interface Harness {
  stateDir: string;
  cleanup: () => Promise<void>;
  state: {
    servers: Record<string, unknown>;
    backupSchedules: { serverId: string; destination?: string }[];
    backupDestination: string | undefined;
    backupVerifyAt: number | undefined;
  };
  backups: BackupService;
  verified: BackupVerification[];
  busy: Set<string>;
  now: number;
  verifier(over?: {
    intervalMs?: number;
    initialDelayMs?: number;
    recheckAfterMs?: number;
    byteBudget?: number;
  }): BackupVerifier;
  archive(serverId: string, backupId: string, createdAt: number, bytes: number): Promise<string>;
  manifest(serverId: string, backupId: string): Promise<BackupManifest>;
}

async function build(): Promise<Harness> {
  const { dir, cleanup } = await tmpDir('mmo-verify-');
  const h: Harness = {
    stateDir: dir,
    cleanup,
    state: {
      servers: { srv_1: {}, srv_2: {} },
      backupSchedules: [],
      backupDestination: undefined,
      backupVerifyAt: undefined,
    },
    backups: undefined as unknown as BackupService,
    verified: [],
    busy: new Set(),
    now: T0,
    verifier: (over = {}) =>
      new BackupVerifier({
        store: storeStub(h),
        backups: h.backups,
        tasks: {
          activeFor: (serverId: string) => (h.busy.has(serverId) ? { taskId: 't' } : undefined),
        } as never,
        logger,
        now: () => h.now,
        initialDelayMs: 0,
        ...over,
      }),
    archive: async (serverId, backupId, createdAt, bytes) => {
      const serverDir = path.join(dir, 'backups', serverId);
      await mkdir(serverDir, { recursive: true });
      const data = Buffer.alloc(bytes, backupId.charCodeAt(backupId.length - 1));
      const archivePath = path.join(serverDir, `${backupId}.tar.gz`);
      await writeFile(archivePath, data);
      const manifest: BackupManifest = {
        backupId,
        serverId,
        kind: 'scheduled',
        createdAt,
        codec: 'gzip',
        archivePath,
        sizeBytes: bytes,
        sha256: createHash('sha256').update(data).digest('hex'),
        files: 1,
        bytesRaw: bytes,
        hot: false,
      };
      await writeFile(path.join(serverDir, `${backupId}.json`), JSON.stringify(manifest));
      return archivePath;
    },
    manifest: async (serverId, backupId) =>
      JSON.parse(
        await readFile(path.join(dir, 'backups', serverId, `${backupId}.json`), 'utf8'),
      ) as BackupManifest,
  };
  h.backups = new BackupService({
    stateDir: dir,
    store: storeStub(h),
    manager: {} as never,
    logger,
    agentVersion: 'test',
    now: () => h.now,
    onRotated: () => undefined,
    onVerified: (v) => {
      h.verified.push(v);
    },
  });
  return h;
}

function storeStub(h: Harness): ConstructorParameters<typeof BackupService>[0]['store'] {
  return {
    get: () => h.state,
    getServer: (id: string) => (id in h.state.servers ? { config: { path: '/srv' } } : undefined),
    update: (fn: (s: typeof h.state) => void) => {
      fn(h.state);
      return Promise.resolve();
    },
  } as never;
}

describe('BackupVerifier — passe périodique sur de vrais fichiers', () => {
  let h: Harness;
  const cleanups: (() => Promise<void>)[] = [];

  beforeEach(async () => {
    h = await build();
    cleanups.push(h.cleanup);
  });
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  it('relit les archives jamais vérifiées, les plus anciennes d’abord, et réinscrit le manifeste', async () => {
    await h.archive('srv_1', 'bk_b', T0 - 2 * DAY, 300);
    await h.archive('srv_2', 'bk_c', T0 - 1 * DAY, 200);
    await h.archive('srv_1', 'bk_a', T0 - 3 * DAY, 100);

    const pass = await h.verifier().runPass();

    expect(pass).toMatchObject({ verified: 3, corrupted: 0, busy: 0, gone: 0, bytes: 600 });
    expect(h.verified.map((v) => v.backupId)).toEqual(['bk_a', 'bk_b', 'bk_c']);
    expect(h.verified.every((v) => v.ok)).toBe(true);
    const m = await h.manifest('srv_1', 'bk_a');
    expect(m.verifiedAt).toBe(T0);
    expect(m.verifyStatus).toBe('ok');
    expect(m.sha256).toHaveLength(64);
    expect(h.state.backupVerifyAt).toBe(T0);
  });

  it('une archive altérée est déclarée corrompue, signalée avec l’écart, et jamais relue', async () => {
    const bad = await h.archive('srv_1', 'bk_bad', T0 - DAY, 100);
    await h.archive('srv_1', 'bk_ok', T0 - HOUR, 100);
    await appendFile(bad, Buffer.from('x'));

    const first = await h.verifier({ intervalMs: 0, recheckAfterMs: 0 }).runPass();
    expect(first).toMatchObject({ verified: 1, corrupted: 1 });
    const report = h.verified.find((v) => v.backupId === 'bk_bad');
    expect(report?.ok).toBe(false);
    expect(report?.sizeBytes).toBe(101);
    expect(report?.expectedSizeBytes).toBe(100);
    expect(report?.sha256).not.toBe(report?.expectedSha256);
    expect((await h.manifest('srv_1', 'bk_bad')).verifyStatus).toBe('corrupted');

    // Seconde passe, fraîcheur nulle : la saine est relue, la corrompue ne l'est plus.
    h.now += HOUR;
    const second = await h.verifier({ intervalMs: 0, recheckAfterMs: 0 }).runPass();
    expect(second).toMatchObject({ verified: 1, corrupted: 0 });
    expect(h.verified.filter((v) => v.backupId === 'bk_bad')).toHaveLength(1);
    expect(h.verified.filter((v) => v.backupId === 'bk_ok')).toHaveLength(2);
  });

  it('ne touche pas aux archives d’un serveur dont une task est en cours', async () => {
    await h.archive('srv_1', 'bk_1', T0 - DAY, 100);
    await h.archive('srv_2', 'bk_2', T0 - DAY, 100);
    h.busy.add('srv_1');

    const pass = await h.verifier().runPass();

    expect(pass).toMatchObject({ verified: 1, busy: 1 });
    expect(h.verified.map((v) => v.backupId)).toEqual(['bk_2']);
    expect((await h.manifest('srv_1', 'bk_1')).verifiedAt).toBeUndefined();
  });

  it('respecte le budget d’octets par passe, une archive au minimum', async () => {
    await h.archive('srv_1', 'bk_1', T0 - 3 * DAY, 100);
    await h.archive('srv_1', 'bk_2', T0 - 2 * DAY, 100);
    await h.archive('srv_1', 'bk_3', T0 - 1 * DAY, 500);

    // Budget inférieur à la plus petite archive : une seule quand même.
    expect(await h.verifier({ byteBudget: 10 }).runPass()).toMatchObject({ verified: 1 });
    expect(h.verified.map((v) => v.backupId)).toEqual(['bk_1']);
    // Budget pour deux petites : la grosse attend la passe suivante.
    h.now += DAY;
    expect(await h.verifier({ byteBudget: 150 }).runPass()).toMatchObject({ verified: 1 });
    expect(h.verified.map((v) => v.backupId)).toEqual(['bk_1', 'bk_2']);
  });

  it('une passe par jour, jamais avant le délai initial, jamais deux en parallèle', async () => {
    await h.archive('srv_1', 'bk_1', T0 - DAY, 100);
    const v = h.verifier({ intervalMs: DAY, initialDelayMs: 10 * 60_000 });

    expect(await v.tick()).toBeUndefined();
    h.now += 10 * 60_000;
    expect(await v.tick()).toMatchObject({ verified: 1 });
    expect(await v.tick()).toBeUndefined();
    h.now += DAY - 1;
    expect(await v.tick()).toBeUndefined();
    h.now += 1;
    // Fraîcheur par défaut (7 j) : l'archive vérifiée hier n'est pas relue, mais la passe a lieu.
    expect(await v.tick()).toMatchObject({ verified: 0 });
    expect(h.verified).toHaveLength(1);
  });

  it('selectForVerification : jamais vérifiées d’abord, puis par ancienneté de vérification, corrompues exclues', () => {
    const m = (over: Partial<BackupManifest>): BackupManifest =>
      ({ backupId: 'x', createdAt: T0, ...over }) as BackupManifest;
    const picked = selectForVerification(
      [
        m({ backupId: 'stale_recent', verifiedAt: T0 - 8 * DAY, createdAt: T0 - 9 * DAY }),
        m({ backupId: 'fresh', verifiedAt: T0 - HOUR, createdAt: T0 - 10 * DAY }),
        m({ backupId: 'never_new', createdAt: T0 - DAY }),
        m({ backupId: 'corrupted', verifiedAt: T0 - 30 * DAY, verifyStatus: 'corrupted' }),
        m({ backupId: 'stale_old', verifiedAt: T0 - 20 * DAY, createdAt: T0 - 21 * DAY }),
        m({ backupId: 'never_old', createdAt: T0 - 5 * DAY }),
      ],
      T0,
      7 * DAY,
    ).map((x) => x.backupId);
    expect(picked).toEqual(['never_old', 'never_new', 'stale_old', 'stale_recent']);
  });
});
