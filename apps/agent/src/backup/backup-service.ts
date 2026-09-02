/**
 * Backups côté agent (doc 05 §6 « Backups », doc 07 phase 8) :
 * - création à chaud : `save-off` → `save-all flush` → archive → `save-on` (RCON d'abord — la
 *   réponse confirme la fin de l'écriture —, stdin sinon avec attente de « Saved the game ») ;
 * - archive `.tar.zst` (gzip en repli) + manifeste `<backupId>.json` (sha256 + taille = intégrité) ;
 * - destination : requête > `agent.configure.backupDestination` > `<stateDir>/backups`, puis
 *   `<destination>/<serverId>/` ;
 * - rotation locale (`keep`, `keepDays`) → `backup.rotated` ;
 * - restauration : vérification du manifeste **avant** de toucher au serveur, arrêt, backup de
 *   sécurité (`pre_restore`), purge du dossier (hors exclusions) puis extraction, relance optionnelle ;
 * - lot 4, deux gardes avant d'écrire (`guards.ts`) : marqueur à la racine d'une destination
 *   explicite (un volume non monté n'est pas une destination), et espace libre contre la taille
 *   estimée de l'archive.
 */
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  safeRelative,
  walkTree,
  type ExcludeFn,
  type ExtractResult,
  type TarListEntry,
  type TarListing,
} from '@mmo/shared/node';

import {
  BROWSE_FILES_PER_DIR,
  BROWSE_MAX_ENTRIES,
  ProtocolError,
  backupManifestSchema,
  ulid,
  type BackupBrowseEntry,
  type BackupBrowseResponse,
  type BackupCodec,
  type BackupKind,
  type BackupManifest,
  type BackupRestorePathsResult,
  type ParsedRequestPayload,
} from '@mmo/protocol';

import { errorMessage, type Logger } from '../log.js';
import type { ServerManager } from '../minecraft/server-manager.js';
import type { ServerProcess } from '../minecraft/server-process.js';
import type { StateStore } from '../state/store.js';
import type { TaskContext } from '../tasks/runner.js';
import { freeBytes as probeFreeBytes } from '../util/disk.js';
import {
  archiveExtension,
  chooseCodec,
  createArchive,
  defaultExclude,
  extractArchive,
  listArchive,
  verifyArchive,
} from './archive.js';
import {
  DESTINATION_MARKER,
  SPACE_HEADROOM_BYTES,
  estimateArchiveBytes,
  hasMarker,
  writeMarker,
} from './guards.js';

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
  /**
   * Lot 4 : résultat d'une relecture complète d'archive (passe périodique du `BackupVerifier`,
   * ou contrôle préalable d'une restauration) — après écriture du manifeste.
   */
  onVerified?: (event: BackupVerification) => void;
  /** Lot 4 : espace libre d'un dossier (défaut `fs.statfs` ; tests : valeur imposée). */
  freeBytes?: (dir: string) => Promise<number | undefined>;
}

/** Ce que la vérification d'une archive a mesuré, et ce que son manifeste annonçait. */
export interface BackupVerification {
  serverId: string;
  backupId: string;
  archivePath: string;
  ts: number;
  ok: boolean;
  sizeBytes: number;
  sha256: string;
  expectedSizeBytes: number;
  expectedSha256: string;
}

export type BackupCreateRequest = Omit<ParsedRequestPayload<'backup.create'>, 'taskId'>;
export type BackupRestoreRequest = Omit<ParsedRequestPayload<'backup.restore'>, 'taskId'>;
export type BackupRestorePathsRequest = Omit<ParsedRequestPayload<'backup.restorePaths'>, 'taskId'>;

export class BackupService {
  private readonly now: () => number;
  private readonly freeBytes: (dir: string) => Promise<number | undefined>;

  constructor(private readonly options: BackupServiceOptions) {
    this.now = options.now ?? (() => Date.now());
    this.freeBytes = options.freeBytes ?? probeFreeBytes;
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

  /** Racine explicite (requête ou réglage global), résolue ; `undefined` = destination par défaut. */
  private explicitRoot(requested: string | undefined): string | undefined {
    const chosen = requested ?? this.options.store.get().backupDestination;
    return chosen === undefined || chosen === '' ? undefined : path.resolve(chosen);
  }

  /** Toutes les racines explicites de la configuration courante (globale + plannings), dédoublonnées. */
  configuredRoots(): string[] {
    const state = this.options.store.get();
    const roots = [state.backupDestination, ...state.backupSchedules.map((s) => s.destination)]
      .filter((d): d is string => d !== undefined && d !== '')
      .map((d) => path.resolve(d));
    return [...new Set(roots)];
  }

  /**
   * Lot 4 — dépose le marqueur sur chaque destination explicite **nouvelle** dans la configuration
   * (jamais sur une destination déjà connue : si son marqueur a disparu, c'est précisément ce que
   * la garde doit faire remonter, pas réparer en silence sur le mauvais disque). Les destinations
   * retirées sont oubliées, donc remises plus tard elles sont marquées à nouveau — c'est le geste
   * documenté pour re-marquer un dossier : le retirer des réglages, puis le remettre.
   */
  async markNewDestinations(): Promise<{
    marked: string[];
    failed: { path: string; error: string }[];
  }> {
    const roots = this.configuredRoots();
    const known = new Set(this.options.store.get().markedDestinations);
    const marked: string[] = [];
    const failed: { path: string; error: string }[] = [];
    for (const root of roots) {
      if (known.has(root)) continue;
      try {
        const written = await writeMarker(root, {
          agentVersion: this.options.agentVersion,
          now: this.now(),
        });
        known.add(root);
        marked.push(root);
        this.options.logger.info(
          written ? 'backup destination marked' : 'backup destination already marked',
          { path: root, marker: DESTINATION_MARKER },
        );
      } catch (error) {
        failed.push({ path: root, error: errorMessage(error) });
      }
    }
    const next = roots.filter((r) => known.has(r));
    const before = this.options.store.get().markedDestinations;
    if (before.length !== next.length || before.some((p, i) => p !== next[i])) {
      await this.options.store.update((s) => {
        s.markedDestinations = next;
      });
    }
    return { marked, failed };
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
    // Garde n°2 AVANT toute création de dossier : un `mkdir` réussi sur un point de montage vide
    // est exactement le scénario silencieux que le marqueur doit interdire.
    const root = this.explicitRoot(options.destination);
    if (root !== undefined && !(await hasMarker(root))) {
      throw new ProtocolError(
        'E_IO',
        `backup destination ${root} has no marker file ${DESTINATION_MARKER}: the folder is probably not mounted or was replaced; nothing was written`,
        {
          retryable: false,
          details: { reason: 'DESTINATION_UNMARKED', path: root, marker: DESTINATION_MARKER },
        },
      );
    }
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
      const exclude = defaultExclude([MARKER, relativeIfInside(sourceDir, destDir) ?? '']);
      // Garde n°1 : inventaire APRÈS `save-all` (les tailles sont stables), estimation contre
      // l'espace libre, refus avant le premier octet écrit. L'inventaire est réutilisé par l'archive.
      ctx.progress('inventory', 5);
      const inventory = await walkTree(sourceDir, exclude);
      await this.assertSpace(serverId, destDir, inventory.bytes, options.destination);
      ctx.throwIfCancelled();
      const result = await createArchive(sourceDir, archivePath, codec, {
        exclude,
        inventory,
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
   * Garde d'espace (lot 4) : taille estimée depuis le taux de compression de la dernière archive du
   * serveur (`estimateArchiveBytes`), comparée à l'espace libre de la destination. Sans mesure
   * possible (`statfs` muet), on n'invente pas de refus.
   */
  private async assertSpace(
    serverId: string,
    destDir: string,
    bytesRaw: number,
    requested: string | undefined,
  ): Promise<void> {
    const free = await this.freeBytes(destDir);
    if (free === undefined) return;
    const history = await this.list(serverId, requested === undefined ? [] : [requested]);
    const estimate = estimateArchiveBytes(bytesRaw, history);
    if (free >= estimate.requiredBytes) return;
    throw insufficientSpace(destDir, estimate.requiredBytes, free, {
      bytesRaw,
      ratio: estimate.ratio,
      ...(estimate.basedOn === undefined ? {} : { basedOn: estimate.basedOn }),
    });
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
          // L'archive est **toujours** à côté du manifeste (déplacement d'un dossier de backups ;
          // phase 12 : un manifeste forgé ne désigne plus un fichier arbitraire à supprimer).
          manifests.push({
            ...parsed.data,
            archivePath: path.join(dir, path.basename(parsed.data.archivePath)),
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

  // --- Vérification (lot 4) -----------------------------------------------------------------

  /**
   * Toutes les archives de tous les serveurs connus, destinations de leurs plannings comprises
   * (une politique peut viser un autre dossier que la destination globale).
   */
  async listAll(): Promise<BackupManifest[]> {
    const state = this.options.store.get();
    const out: BackupManifest[] = [];
    for (const serverId of Object.keys(state.servers)) {
      const extra = state.backupSchedules.flatMap((s) =>
        s.serverId === serverId && s.destination !== undefined ? [s.destination] : [],
      );
      out.push(...(await this.list(serverId, extra)));
    }
    return out;
  }

  /**
   * Relit l'archive en entier (taille + sha256 contre le manifeste), écrit le résultat dans le
   * manifeste (`verifiedAt`, `verifyStatus`) et le signale. `undefined` si l'archive a disparu
   * entre-temps (la rotation ou l'utilisateur sont passés par là : rien à dire).
   */
  async verify(
    manifest: BackupManifest,
    options: { shouldAbort?: () => boolean } = {},
  ): Promise<BackupVerification | undefined> {
    if (!(await exists(manifest.archivePath))) return undefined;
    const check = await verifyArchive(manifest.archivePath, manifest, options);
    return this.recordVerification(manifest, check);
  }

  private async recordVerification(
    manifest: BackupManifest,
    check: { ok: boolean; sizeBytes: number; sha256: string },
  ): Promise<BackupVerification> {
    const ts = this.now();
    const updated: BackupManifest = {
      ...manifest,
      verifiedAt: ts,
      verifyStatus: check.ok ? 'ok' : 'corrupted',
    };
    try {
      await writeFile(manifestPathFor(manifest), JSON.stringify(updated, null, 2) + '\n');
    } catch (error) {
      // Un manifeste non réinscriptible (destination en lecture seule) n'invalide pas la mesure.
      this.options.logger.warn('could not record the verification in the manifest', {
        backupId: manifest.backupId,
        error: errorMessage(error),
      });
    }
    const event: BackupVerification = {
      serverId: manifest.serverId,
      backupId: manifest.backupId,
      archivePath: manifest.archivePath,
      ts,
      ok: check.ok,
      sizeBytes: check.sizeBytes,
      sha256: check.sha256,
      expectedSizeBytes: manifest.sizeBytes,
      expectedSha256: manifest.sha256,
    };
    if (!check.ok) {
      this.options.logger.warn('backup archive does not match its manifest', {
        serverId: manifest.serverId,
        backupId: manifest.backupId,
        archivePath: manifest.archivePath,
        expectedSizeBytes: manifest.sizeBytes,
        sizeBytes: check.sizeBytes,
      });
    }
    this.options.onVerified?.(event);
    return event;
  }

  /** Rotation : voir `selectForRotation` pour la règle de sélection. */
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
    const deleted = selectForRotation(candidates, options, this.now());
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
    await this.verifyBeforeRestore(manifest, ctx);

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

  /**
   * Relit l'archive en entier avant toute restauration (`E_CHECKSUM_MISMATCH` sans rien modifier).
   * Ce contrôle compte comme une vérification : le manifeste et le panel en gardent la trace,
   * corrompue ou non.
   */
  private async verifyBeforeRestore(manifest: BackupManifest, ctx: TaskContext): Promise<void> {
    ctx.progress('verifying', 0);
    const check = await verifyArchive(manifest.archivePath, manifest, {
      shouldAbort: () => ctx.isCancelled,
      onProgress: (bytes) => {
        ctx.progress('verifying', (bytes / Math.max(1, manifest.sizeBytes)) * 10);
      },
    });
    if (!ctx.isCancelled) await this.recordVerification(manifest, check);
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
  }

  // --- Restauration partielle (lot 4) ---------------------------------------------------------

  /** Ce qu'aucune restauration partielle ne touche : les exclusions d'archive du serveur. */
  private reservedFor(sourceDir: string): ExcludeFn {
    return defaultExclude([
      MARKER,
      relativeIfInside(sourceDir, this.destinationFor(undefined)) ?? '',
    ]);
  }

  /**
   * Validation **synchrone** des chemins d'une restauration partielle, avant même de créer la
   * task (le panel reçoit un 400, pas une task en échec) : jailés, jamais réservés, dédoublonnés.
   * Rejouée par l'exécuteur.
   */
  restorablePaths(serverId: string, paths: readonly string[]): string[] {
    const record = this.options.store.getServer(serverId);
    if (!record) throw new ProtocolError('E_NOT_FOUND', `unknown server ${serverId}`);
    return normalizeRestorePaths(paths, this.reservedFor(record.config.path));
  }

  /** Exécuteur de `backup.browse` : une passe de lecture d'en-têtes, aucun octet extrait. */
  async browse(
    serverId: string,
    backupId: string,
    archivePath?: string,
  ): Promise<BackupBrowseResponse> {
    const manifest = await this.find(serverId, backupId, archivePath);
    const listing = await this.listing(manifest);
    return summarizeListing(listing.entries);
  }

  private async listing(
    manifest: BackupManifest,
    shouldAbort?: () => boolean,
  ): Promise<TarListing> {
    try {
      return await listArchive(manifest.archivePath, manifest.codec, {
        ...(shouldAbort === undefined ? {} : { shouldAbort }),
      });
    } catch (error) {
      if (error instanceof ProtocolError) throw error;
      throw new ProtocolError(
        'E_IO',
        `cannot read archive ${manifest.backupId}: ${errorMessage(error)}`,
        {
          cause: error,
          retryable: false,
          details: { reason: 'ARCHIVE_UNREADABLE', backupId: manifest.backupId },
        },
      );
    }
  }

  /**
   * Exécuteur de la task `backup.restorePaths`. Ordre des gardes, toutes AVANT le premier geste
   * irréversible : chemins normalisés et jamais réservés → archive conforme à son manifeste →
   * **chaque chemin demandé existe dans l'archive** (sinon, en place, on aurait supprimé le dossier
   * courant pour ne rien remettre à la place) → espace libre (côte à côte). Côte à côte, le serveur
   * n'est ni arrêté ni touché : tout va dans `restored-<date>/` à sa racine.
   */
  async restorePaths(
    req: BackupRestorePathsRequest,
    ctx: TaskContext,
  ): Promise<BackupRestorePathsResult> {
    const { serverId } = req;
    const record = this.options.store.getServer(serverId);
    if (!record) throw new ProtocolError('E_NOT_FOUND', `unknown server ${serverId}`);
    const sourceDir = record.config.path;
    const paths = normalizeRestorePaths(req.paths, this.reservedFor(sourceDir));
    const include = includePredicate(paths);
    const manifest = await this.find(serverId, req.backupId, req.archivePath);
    await this.verifyBeforeRestore(manifest, ctx);

    ctx.progress('listing', 10);
    let listing: TarListing;
    try {
      listing = await this.listing(manifest, () => ctx.isCancelled);
    } catch (error) {
      if (ctx.isCancelled)
        throw new ProtocolError('E_CANCELLED', 'restore cancelled', { cause: error });
      throw error;
    }
    const missing = paths.filter(
      (p) => !listing.entries.some((e) => e.rel === p || e.rel.startsWith(`${p}/`)),
    );
    if (missing.length > 0) {
      throw new ProtocolError(
        'E_NOT_FOUND',
        `not in archive ${manifest.backupId}: ${missing.join(', ')}`,
        {
          retryable: false,
          details: {
            reason: 'PATHS_NOT_IN_ARCHIVE',
            backupId: manifest.backupId,
            paths: missing,
            list: missing.join(', '),
          },
        },
      );
    }
    const bytesSelected = listing.entries
      .filter((e) => e.kind === 'file' && include(e.rel, 'file'))
      .reduce((n, e) => n + e.size, 0);
    ctx.throwIfCancelled();

    const proc = this.options.manager.get(serverId);
    const wasRunning = proc?.isRunning ?? false;

    if (req.mode === 'side_by_side') {
      ctx.progress('preparing', 15);
      const free = await this.freeBytes(sourceDir);
      if (free !== undefined && free < bytesSelected + SPACE_HEADROOM_BYTES) {
        throw insufficientSpace(sourceDir, bytesSelected + SPACE_HEADROOM_BYTES, free, {
          bytesRaw: bytesSelected,
        });
      }
      const destination = await allocateRestoredDir(sourceDir, this.now());
      const destDir = path.join(sourceDir, destination);
      ctx.artifact(destDir);
      await ctx.checkpoint();
      ctx.progress('extracting', 20);
      const extracted = await this.extractSelection(
        manifest,
        destDir,
        include,
        bytesSelected,
        ctx,
        {
          from: 20,
          span: 78,
        },
      );
      ctx.keep(destDir);
      return {
        backupId: manifest.backupId,
        mode: 'side_by_side',
        paths,
        destination,
        files: extracted.files,
        bytes: extracted.bytes,
        restarted: false,
        wasRunning,
      };
    }

    if (wasRunning) {
      ctx.progress('stopping', 15);
      await this.options.manager.stop(serverId, { forceAfterTimeout: true });
    }
    ctx.throwIfCancelled();
    let safetyBackup: BackupManifest | undefined;
    if (req.safetyBackup) {
      ctx.progress('safety_backup', 20);
      const safetyId = req.safetyBackupId ?? ulid(this.now());
      safetyBackup = await this.createInternal(serverId, safetyId, 'pre_restore', ctx, {
        comment: `before partial restore of ${manifest.backupId}`,
      });
      ctx.progress('safety_backup', 45);
    }
    ctx.throwIfCancelled();
    // À partir d'ici l'opération est irréversible (hors backup de sécurité) : journal écrit d'abord.
    await ctx.checkpoint();
    ctx.progress('clearing', 50);
    for (const p of paths) {
      await rm(path.join(sourceDir, ...p.split('/')), {
        recursive: true,
        force: true,
        maxRetries: 3,
      });
    }
    ctx.progress('extracting', 55);
    const extracted = await this.extractSelection(
      manifest,
      sourceDir,
      include,
      bytesSelected,
      ctx,
      {
        from: 55,
        span: 40,
      },
    );
    let restarted = false;
    if (req.restartAfter) {
      ctx.progress('restarting', 97);
      await this.options.manager.start(serverId);
      restarted = true;
    }
    return {
      backupId: manifest.backupId,
      mode: 'in_place',
      paths,
      files: extracted.files,
      bytes: extracted.bytes,
      ...(safetyBackup === undefined ? {} : { safetyBackup }),
      restarted,
      wasRunning,
    };
  }

  private async extractSelection(
    manifest: BackupManifest,
    dest: string,
    include: ExcludeFn,
    bytesTotal: number,
    ctx: TaskContext,
    range: { from: number; span: number },
  ): Promise<ExtractResult> {
    try {
      return await extractArchive(manifest.archivePath, manifest.codec, dest, {
        include,
        shouldAbort: () => ctx.isCancelled,
        onProgress: (p) => {
          ctx.progress(
            'extracting',
            range.from + (p.bytes / Math.max(1, bytesTotal)) * range.span,
            p.current,
          );
        },
      });
    } catch (error) {
      if (ctx.isCancelled)
        throw new ProtocolError('E_CANCELLED', 'restore cancelled', { cause: error });
      throw new ProtocolError('E_IO', `restore failed: ${errorMessage(error)}`, {
        cause: error,
        details: { backupId: manifest.backupId },
      });
    }
  }
}

// --- Restauration partielle : fonctions pures (lot 4) ---------------------------------------------

/**
 * Chemins normalisés (`safeRelative`), dédoublonnés, sans ceux qu'un autre chemin de la liste couvre
 * déjà (`world` + `world/region` → `world`). Un chemin que l'agent n'archive jamais (marqueur,
 * journaux, corbeille, dossiers restaurés…) est refusé : en place, on l'aurait supprimé pour ne
 * rien remettre.
 */
export function normalizeRestorePaths(raw: readonly string[], reserved: ExcludeFn): string[] {
  const out = new Set<string>();
  for (const p of raw) {
    const rel = safeRelative(p);
    if (rel === undefined) {
      throw new ProtocolError('E_INVALID_PAYLOAD', `invalid path ${p}`, { details: { path: p } });
    }
    if (isReservedPath(rel, reserved)) {
      throw new ProtocolError(
        'E_INVALID_PAYLOAD',
        `${rel} is managed by the agent and is never restored`,
        { retryable: false, details: { reason: 'RESERVED_PATH', path: rel } },
      );
    }
    out.add(rel);
  }
  const all = [...out].sort();
  return all.filter((p) => !all.some((q) => q !== p && p.startsWith(`${q}/`)));
}

function isReservedPath(rel: string, exclude: ExcludeFn): boolean {
  const parts = rel.split('/');
  for (let i = 1; i <= parts.length; i++) {
    const prefix = parts.slice(0, i).join('/');
    if (exclude(prefix, 'dir') || exclude(prefix, 'file')) return true;
  }
  return false;
}

/** Prédicat d'inclusion : un chemin choisi vaut lui-même et tout ce qu'il contient. */
export function includePredicate(paths: readonly string[]): ExcludeFn {
  return (rel) => paths.some((p) => rel === p || rel.startsWith(`${p}/`));
}

/** Nom d'un dossier `restored-<yyyymmdd>-<hhmmss>` libre à la racine du serveur (suffixe `-n` si pris). */
export async function allocateRestoredDir(sourceDir: string, now: number): Promise<string> {
  const d = new Date(now);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${String(d.getFullYear())}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  for (let n = 1; n < 1000; n++) {
    const name = n === 1 ? `restored-${stamp}` : `restored-${stamp}-${String(n)}`;
    try {
      await mkdir(path.join(sourceDir, name));
      return name;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  throw new ProtocolError('E_IO', 'cannot allocate a restore folder', { retryable: false });
}

function parentOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

/**
 * Réponse de `backup.browse` à partir des entrées brutes du tar : chaque dossier porte la taille et
 * le nombre de fichiers qu'il contient (récursif, listés ou non) ; au plus `perDir` fichiers sont
 * listés par dossier, `maxEntries` entrées en tout — les dossiers passent toujours en premier, un
 * dossier se restaure entier quoi qu'il en soit. Un dossier parent absent de l'archive (archive
 * étrangère) est synthétisé.
 */
export function summarizeListing(
  entries: readonly TarListEntry[],
  limits: { perDir: number; maxEntries: number } = {
    perDir: BROWSE_FILES_PER_DIR,
    maxEntries: BROWSE_MAX_ENTRIES,
  },
): BackupBrowseResponse {
  interface DirAgg {
    entry: BackupBrowseEntry;
    listed: number;
  }
  const root: DirAgg = { entry: { path: '', kind: 'dir', size: 0, files: 0 }, listed: 0 };
  const dirs = new Map<string, DirAgg>();
  const files: BackupBrowseEntry[] = [];
  let totalFiles = 0;
  let totalBytes = 0;
  let truncated = false;
  const dirOf = (p: string): DirAgg => {
    if (p === '') return root;
    let agg = dirs.get(p);
    if (agg === undefined) {
      agg = { entry: { path: p, kind: 'dir', size: 0, files: 0 }, listed: 0 };
      dirs.set(p, agg);
      dirOf(parentOf(p));
    }
    return agg;
  };
  for (const e of entries) {
    if (e.kind === 'dir') {
      const agg = dirOf(e.rel);
      if (e.mtimeMs > 0) agg.entry.modifiedAt = e.mtimeMs;
      continue;
    }
    if (e.kind !== 'file') continue;
    totalFiles++;
    totalBytes += e.size;
    const parent = parentOf(e.rel);
    for (let a = parent; a !== ''; a = parentOf(a)) {
      const agg = dirOf(a);
      agg.entry.size += e.size;
      agg.entry.files = (agg.entry.files ?? 0) + 1;
    }
    const holder = dirOf(parent);
    if (holder.listed >= limits.perDir) {
      holder.entry.truncated = true;
      truncated = true;
      continue;
    }
    holder.listed++;
    files.push({
      path: e.rel,
      kind: 'file',
      size: e.size,
      ...(e.mtimeMs > 0 ? { modifiedAt: e.mtimeMs } : {}),
    });
  }
  const byPath = (a: BackupBrowseEntry, b: BackupBrowseEntry): number =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  let out = [...[...dirs.values()].map((d) => d.entry).sort(byPath), ...files.sort(byPath)];
  if (out.length > limits.maxEntries) {
    out = out.slice(0, limits.maxEntries);
    truncated = true;
  }
  return { entries: out, totalFiles, totalBytes, truncated };
}

/** `E_IO` non réessayable `INSUFFICIENT_SPACE`, avec les chiffres que l'UI affiche. */
function insufficientSpace(
  dir: string,
  requiredBytes: number,
  freeBytes: number,
  extra: Record<string, unknown>,
): ProtocolError {
  const mb = (n: number): number => Math.ceil(n / 1_048_576);
  return new ProtocolError(
    'E_IO',
    `not enough free space on ${dir}: about ${String(mb(requiredBytes))} MB needed, ${String(mb(freeBytes))} MB free`,
    {
      retryable: false,
      details: {
        reason: 'INSUFFICIENT_SPACE',
        path: dir,
        requiredBytes,
        freeBytes,
        requiredMb: mb(requiredBytes),
        freeMb: mb(freeBytes),
        ...extra,
      },
    },
  );
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

/**
 * Sélectionne les sauvegardes à supprimer. `candidates` est trié du plus récent au plus ancien.
 *
 * **La plus récente n'est jamais supprimée pour cause d'âge.** Sans cette garde, un serveur
 * inactif 30 jours avec `keepDays: 14` se retrouvait sans aucune sauvegarde : les anciennes
 * périmaient et aucune nouvelle n'était produite pour les remplacer. `keep`, lui, reste appliqué
 * tel quel (un `keep: 0` explicite doit pouvoir tout supprimer).
 */
export function selectForRotation(
  candidates: readonly { backupId: string; archivePath: string; createdAt: number }[],
  options: { keep?: number; keepDays?: number },
  now: number,
): { backupId: string; archivePath: string }[] {
  const limitDate =
    options.keepDays === undefined ? undefined : now - options.keepDays * 86_400_000;
  const deleted: { backupId: string; archivePath: string }[] = [];
  candidates.forEach((m, index) => {
    const tooMany = options.keep !== undefined && index >= options.keep;
    const tooOld = limitDate !== undefined && m.createdAt < limitDate && index > 0;
    if (tooMany || tooOld) deleted.push({ backupId: m.backupId, archivePath: m.archivePath });
  });
  return deleted;
}
