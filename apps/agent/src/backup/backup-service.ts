/**
 * Backups côté agent (doc 05 §6 « Backups », doc 07 phase 8) :
 * - création à chaud : `save-off` → `save-all flush` → archive → `save-on` (RCON d'abord — la
 *   réponse confirme la fin de l'écriture —, stdin sinon avec attente de « Saved the game ») ;
 * - archive `.tar.zst` (gzip en repli) + manifeste `<backupId>.json` (sha256 + taille = intégrité) ;
 * - destination : requête > `agent.configure.backupDestination` > `<stateDir>/backups`, puis
 *   `<destination>/<serverId>/` ;
 * - rotation locale (`keep`, `keepDays`) → `backup.rotated` ;
 * - restauration : vérification du manifeste **avant** de toucher au serveur, arrêt, backup de
 *   sécurité (`pre_restore`), purge du dossier (hors exclusions) puis extraction, relance optionnelle.
 */
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  ProtocolError,
  backupManifestSchema,
  ulid,
  type BackupCodec,
  type BackupKind,
  type BackupManifest,
  type ParsedRequestPayload,
} from '@mmo/protocol';

import { errorMessage, type Logger } from '../log.js';
import type { ServerManager } from '../minecraft/server-manager.js';
import type { ServerProcess } from '../minecraft/server-process.js';
import type { StateStore } from '../state/store.js';
import type { TaskContext } from '../tasks/runner.js';
import {
  archiveExtension,
  chooseCodec,
  createArchive,
  defaultExclude,
  extractArchive,
  verifyArchive,
} from './archive.js';

/** Jamais archivé ni effacé par une restauration : le marqueur d'identité du dossier. */
const MARKER = '.mmo-server.json';
const SAVE_TIMEOUT_MS = 120_000;
const SAVED_PATTERN = /Saved the (game|world)|Saving chunks|ThreadedAnvilChunkStorage/i;

export interface BackupServiceOptions {
  stateDir: string;
  store: StateStore;
  manager: ServerManager;
  logger: Logger;
  agentVersion: string;
  now?: () => number;
  onRotated: (event: {
    serverId: string;
    policyId: string | undefined;
    deleted: { backupId: string; archivePath: string }[];
  }) => void;
  /** Attente après `save-all` en stdin quand aucune confirmation console n'arrive (défaut 3 s). */
  saveSettleMs?: number;
}

export type BackupCreateRequest = Omit<ParsedRequestPayload<'backup.create'>, 'taskId'>;
export type BackupRestoreRequest = Omit<ParsedRequestPayload<'backup.restore'>, 'taskId'>;

export class BackupService {
  private readonly now: () => number;

  constructor(private readonly options: BackupServiceOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  // --- Destinations -------------------------------------------------------------------------

  defaultDestination(): string {
    return path.join(this.options.stateDir, 'backups');
  }

  /** Dossier racine des sauvegardes (hors serveur) pour une requête donnée. */
  destinationFor(requested: string | undefined): string {
    const global = this.options.store.get().backupDestination;
    return path.resolve(requested ?? global ?? this.defaultDestination());
  }

  serverDestination(serverId: string, requested?: string): string {
    return path.join(this.destinationFor(requested), sanitize(serverId));
  }

  /** Toutes les racines où chercher des archives d'un serveur. */
  private searchDirs(serverId: string, extra: string[] = []): string[] {
    const dirs = [
      this.serverDestination(serverId),
      path.join(this.defaultDestination(), sanitize(serverId)),
      ...extra.map((d) => path.join(path.resolve(d), sanitize(serverId))),
    ];
    return [...new Set(dirs.map((d) => path.normalize(d)))];
  }

  // --- Création -------------------------------------------------------------------------------

  /** Exécuteur de la task `backup.create`. */
  async create(
    req: BackupCreateRequest,
    ctx: TaskContext,
  ): Promise<BackupManifest & { durationMs: number }> {
    const startedAt = this.now();
    const backupId = req.backupId ?? ulid(startedAt);
    const manifest = await this.createInternal(req.serverId, backupId, req.kind, ctx, {
      ...(req.policyId === undefined ? {} : { policyId: req.policyId }),
      ...(req.destination === undefined ? {} : { destination: req.destination }),
      ...(req.codec === undefined ? {} : { codec: req.codec }),
      ...(req.comment === undefined ? {} : { comment: req.comment }),
    });
    if (req.keep !== undefined || req.keepDays !== undefined) {
      await this.rotate(req.serverId, {
        ...(req.keep === undefined ? {} : { keep: req.keep }),
        ...(req.keepDays === undefined ? {} : { keepDays: req.keepDays }),
        ...(req.policyId === undefined ? {} : { policyId: req.policyId }),
        ...(req.destination === undefined ? {} : { destination: req.destination }),
      });
    }
    return { ...manifest, durationMs: this.now() - startedAt };
  }

  private async createInternal(
    serverId: string,
    backupId: string,
    kind: BackupKind,
    ctx: TaskContext,
    options: { policyId?: string; destination?: string; codec?: BackupCodec; comment?: string },
  ): Promise<BackupManifest> {
    const record = this.options.store.getServer(serverId);
    if (!record) throw new ProtocolError('E_NOT_FOUND', `unknown server ${serverId}`);
    const sourceDir = record.config.path;
    const destDir = this.serverDestination(serverId, options.destination);
    await mkdir(destDir, { recursive: true });
    const codec = chooseCodec(options.codec);
    const archivePath = path.join(destDir, `${sanitize(backupId)}${archiveExtension(codec)}`);
    const manifestPath = path.join(destDir, `${sanitize(backupId)}.json`);
    if (await exists(manifestPath)) {
      throw new ProtocolError('E_CONFLICT', `backup ${backupId} already exists`, {
        details: { backupId },
      });
    }
    ctx.artifact(`${archivePath}.part`);
    ctx.artifact(archivePath);
    await ctx.checkpoint();

    const proc = this.options.manager.get(serverId);
    const hotProc = proc?.isRunning ? proc : undefined;
    const hot = hotProc !== undefined;
    ctx.progress('preparing', 0);
    let savingDisabled = false;
    try {
      if (hotProc) {
        ctx.progress('saving', 2);
        await this.saveCommand(hotProc, 'save-off');
        savingDisabled = true;
        await this.saveCommand(hotProc, 'save-all flush', true);
      }
      ctx.throwIfCancelled();
      const result = await createArchive(sourceDir, archivePath, codec, {
        exclude: defaultExclude([MARKER, relativeIfInside(sourceDir, destDir) ?? '']),
        shouldAbort: () => ctx.isCancelled,
        onProgress: (p) => {
          if (p.phase === 'inventory') {
            ctx.progress('inventory', 5);
            return;
          }
          const pct = p.bytesTotal === 0 ? 95 : 5 + (p.bytes / p.bytesTotal) * 90;
          ctx.progress('archiving', pct, p.current);
        },
      });
      ctx.throwIfCancelled();
      const manifest: BackupManifest = {
        backupId,
        serverId,
        kind,
        ...(options.policyId === undefined ? {} : { policyId: options.policyId }),
        createdAt: this.now(),
        codec,
        archivePath,
        sizeBytes: result.sizeBytes,
        sha256: result.sha256,
        files: result.files,
        bytesRaw: result.bytesRaw,
        hot,
        ...(record.config.name === undefined ? {} : { serverName: record.config.name }),
        ...(record.config.mcVersion === undefined ? {} : { mcVersion: record.config.mcVersion }),
        ...(record.config.loader === undefined ? {} : { loader: record.config.loader }),
        agentVersion: this.options.agentVersion,
        ...(options.comment === undefined ? {} : { comment: options.comment }),
      };
      ctx.progress('finalizing', 97);
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
      ctx.keep(archivePath);
      ctx.keep(`${archivePath}.part`);
      if (result.skipped.length > 0) {
        this.options.logger.info('backup: entries skipped', {
          serverId,
          backupId,
          skipped: result.skipped.slice(0, 20),
        });
      }
      return manifest;
    } catch (error) {
      if (ctx.isCancelled)
        throw new ProtocolError('E_CANCELLED', 'backup cancelled', { cause: error });
      if (error instanceof ProtocolError) throw error;
      throw new ProtocolError('E_IO', `backup failed: ${errorMessage(error)}`, { cause: error });
    } finally {
      if (savingDisabled && hotProc) {
        await this.saveCommand(hotProc, 'save-on').catch((e: unknown) => {
          this.options.logger.warn('save-on failed after backup', {
            serverId,
            error: errorMessage(e),
          });
        });
      }
    }
  }

  /**
   * Commande de sauvegarde : RCON si disponible (réponse = confirmation), sinon stdin puis attente de
   * la ligne « Saved the game » (au plus `SAVE_TIMEOUT_MS`, sinon délai fixe).
   */
  private async saveCommand(
    proc: ServerProcess,
    command: string,
    waitSaved = false,
  ): Promise<void> {
    if (proc.rcon && proc.state === 'running') {
      try {
        await proc.rconExec(command, SAVE_TIMEOUT_MS);
        return;
      } catch (error) {
        this.options.logger.info('rcon save command failed, falling back to stdin', {
          command,
          error: errorMessage(error),
        });
      }
    }
    const since = proc.buffer.latestSeq ?? 0;
    await proc.sendCommand(command);
    if (!waitSaved) return;
    // stdin n'accuse rien : on attend « Saved the game », sinon un silence console de `settle` ms
    // (serveur moddé au message différent), avec un plafond dur.
    const settle = this.options.saveSettleMs ?? 3000;
    const deadline = this.now() + SAVE_TIMEOUT_MS;
    let lastActivity = this.now();
    let seen = 0;
    while (this.now() < deadline && proc.isRunning) {
      const { lines } = proc.buffer.since(since);
      if (lines.some((l) => SAVED_PATTERN.test(l.text))) return;
      if (lines.length !== seen) {
        seen = lines.length;
        lastActivity = this.now();
      }
      if (this.now() - lastActivity >= settle) return;
      await sleep(100);
    }
  }

  // --- Listage / suppression ----------------------------------------------------------------

  async list(serverId: string, extraDestinations: string[] = []): Promise<BackupManifest[]> {
    const out = new Map<string, BackupManifest>();
    for (const dir of this.searchDirs(serverId, extraDestinations)) {
      for (const m of await this.readManifests(dir)) {
        if (m.serverId !== serverId) continue;
        if (!(await exists(m.archivePath))) continue;
        out.set(m.backupId, m);
      }
    }
    return [...out.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  private async readManifests(dir: string): Promise<BackupManifest[]> {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return [];
    }
    const manifests: BackupManifest[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(dir, name);
      try {
        const parsed = backupManifestSchema.safeParse(JSON.parse(await readFile(file, 'utf8')));
        if (parsed.success) {
          // L'archive est attendue à côté du manifeste (déplacement d'un dossier de backups).
          const local = path.join(dir, path.basename(parsed.data.archivePath));
          manifests.push({
            ...parsed.data,
            archivePath: (await exists(parsed.data.archivePath)) ? parsed.data.archivePath : local,
          });
        }
      } catch {
        // manifeste illisible : ignoré
      }
    }
    return manifests;
  }

  async find(serverId: string, backupId: string, archivePath?: string): Promise<BackupManifest> {
    if (archivePath !== undefined) {
      const dir = path.dirname(archivePath);
      const m = (await this.readManifests(dir)).find((x) => x.backupId === backupId);
      if (m) return m;
    }
    const m = (await this.list(serverId)).find((x) => x.backupId === backupId);
    if (!m) {
      throw new ProtocolError('E_NOT_FOUND', `backup ${backupId} not found`, {
        details: { backupId, serverId },
      });
    }
    return m;
  }

  async delete(serverId: string, backupId: string, archivePath?: string): Promise<boolean> {
    let m: BackupManifest;
    try {
      m = await this.find(serverId, backupId, archivePath);
    } catch {
      return false;
    }
    await rm(m.archivePath, { force: true });
    await rm(manifestPathFor(m), { force: true });
    return true;
  }

  /** Rotation : garde les `keep` plus récentes (même politique) et supprime celles plus vieilles que `keepDays`. */
  async rotate(
    serverId: string,
    options: { keep?: number; keepDays?: number; policyId?: string; destination?: string },
  ): Promise<{ backupId: string; archivePath: string }[]> {
    const all = await this.list(
      serverId,
      options.destination === undefined ? [] : [options.destination],
    );
    const candidates = all.filter((m) =>
      options.policyId === undefined ? m.kind === 'scheduled' : m.policyId === options.policyId,
    );
    const deleted: { backupId: string; archivePath: string }[] = [];
    const limitDate =
      options.keepDays === undefined ? undefined : this.now() - options.keepDays * 86_400_000;
    candidates.forEach((m, index) => {
      const tooMany = options.keep !== undefined && index >= options.keep;
      const tooOld = limitDate !== undefined && m.createdAt < limitDate;
      if (tooMany || tooOld) deleted.push({ backupId: m.backupId, archivePath: m.archivePath });
    });
    for (const d of deleted) {
      const m = candidates.find((c) => c.backupId === d.backupId);
      if (!m) continue;
      await rm(m.archivePath, { force: true }).catch(() => undefined);
      await rm(manifestPathFor(m), { force: true }).catch(() => undefined);
    }
    if (deleted.length > 0) {
      this.options.onRotated({ serverId, policyId: options.policyId, deleted });
    }
    return deleted;
  }

  // --- Restauration -------------------------------------------------------------------------

  /** Exécuteur de la task `backup.restore`. */
  async restore(
    req: BackupRestoreRequest,
    ctx: TaskContext,
  ): Promise<{
    backupId: string;
    safetyBackup?: BackupManifest;
    files: number;
    bytes: number;
    restarted: boolean;
    wasRunning: boolean;
  }> {
    const { serverId } = req;
    const record = this.options.store.getServer(serverId);
    if (!record) throw new ProtocolError('E_NOT_FOUND', `unknown server ${serverId}`);
    const manifest = await this.find(serverId, req.backupId, req.archivePath);

    ctx.progress('verifying', 0);
    const check = await verifyArchive(manifest.archivePath, manifest, {
      shouldAbort: () => ctx.isCancelled,
      onProgress: (bytes) => {
        ctx.progress('verifying', (bytes / Math.max(1, manifest.sizeBytes)) * 10);
      },
    });
    if (!check.ok) {
      throw new ProtocolError('E_CHECKSUM_MISMATCH', 'archive does not match its manifest', {
        retryable: false,
        details: {
          backupId: manifest.backupId,
          expectedSha256: manifest.sha256,
          actualSha256: check.sha256,
          expectedSize: manifest.sizeBytes,
          actualSize: check.sizeBytes,
        },
      });
    }
    ctx.throwIfCancelled();

    const proc = this.options.manager.get(serverId);
    const wasRunning = proc?.isRunning ?? false;
    if (wasRunning) {
      ctx.progress('stopping', 10);
      await this.options.manager.stop(serverId, { forceAfterTimeout: true });
    }
    ctx.throwIfCancelled();

    let safetyBackup: BackupManifest | undefined;
    if (req.safetyBackup) {
      ctx.progress('safety_backup', 15);
      const safetyId = req.safetyBackupId ?? ulid(this.now());
      safetyBackup = await this.createInternal(serverId, safetyId, 'pre_restore', ctx, {
        comment: `before restore of ${manifest.backupId}`,
      });
      ctx.progress('safety_backup', 45);
    }
    ctx.throwIfCancelled();

    // À partir d'ici l'opération est irréversible (hors backup de sécurité) : journal écrit d'abord.
    await ctx.checkpoint();
    ctx.progress('clearing', 50);
    const sourceDir = record.config.path;
    const exclude = defaultExclude([
      MARKER,
      relativeIfInside(sourceDir, this.destinationFor(undefined)) ?? '',
    ]);
    for (const name of await readdir(sourceDir)) {
      if (exclude(name, 'dir') || exclude(name, 'file')) continue;
      await rm(path.join(sourceDir, name), { recursive: true, force: true, maxRetries: 3 });
    }

    ctx.progress('extracting', 55);
    let extracted: { files: number; bytes: number };
    try {
      extracted = await extractArchive(manifest.archivePath, manifest.codec, sourceDir, {
        shouldAbort: () => ctx.isCancelled,
        onProgress: (p) => {
          ctx.progress(
            'extracting',
            55 + (p.bytes / Math.max(1, manifest.bytesRaw)) * 40,
            p.current,
          );
        },
      });
    } catch (error) {
      if (ctx.isCancelled)
        throw new ProtocolError('E_CANCELLED', 'restore cancelled', { cause: error });
      throw new ProtocolError('E_IO', `restore failed: ${errorMessage(error)}`, {
        cause: error,
        details: { backupId: manifest.backupId, safetyBackupId: safetyBackup?.backupId ?? null },
      });
    }

    let restarted = false;
    if (req.restartAfter) {
      ctx.progress('restarting', 97);
      await this.options.manager.start(serverId);
      restarted = true;
    }
    return {
      backupId: manifest.backupId,
      ...(safetyBackup === undefined ? {} : { safetyBackup }),
      files: extracted.files,
      bytes: extracted.bytes,
      restarted,
      wasRunning,
    };
  }
}

function manifestPathFor(m: BackupManifest): string {
  return path.join(path.dirname(m.archivePath), `${sanitize(m.backupId)}.json`);
}

function sanitize(id: string): string {
  return id.replace(/[^A-Za-z0-9_.-]/g, '_');
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/** Si `inner` est dans `outer`, son premier segment relatif (à exclure de l'archive). */
function relativeIfInside(outer: string, inner: string): string | undefined {
  const rel = path.relative(path.resolve(outer), path.resolve(inner));
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  return rel.split(path.sep)[0];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
