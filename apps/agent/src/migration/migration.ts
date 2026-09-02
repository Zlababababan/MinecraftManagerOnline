/**
 * Migration agent → agent, côté agent (phase 9, doc 05 §8). Le panel orchestre ; l'agent joue :
 * - **source** : `migration.export` (task : arrêt du serveur s'il tourne, backup `pre_migration`),
 *   `transfer.serve` (listener HTTP one-shot sur les adresses **privées**, jeton unique, TTL, `Range`),
 *   `migration.finalize` (renommage `<dossier>.migrated-<date>`, marqueur retiré, purge différée 7 j) ;
 * - **cible** : `migration.precheck` (dossier, port, JRE, espace disque), `migration.import` (task :
 *   téléchargement avec reprise depuis les sources directes puis le relais panel, vérification du
 *   manifeste, extraction, marqueur d'identité, enregistrement de la configuration, relance optionnelle).
 * Rien n'est détruit côté source avant la confirmation du panel (`finalize`).
 */
import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import {
  ProtocolError,
  type BackupManifest,
  type MigrationPrecheckResult,
  type ParsedRequestPayload,
} from '@mmo/protocol';

import { extractArchive, verifyArchive } from '../backup/archive.js';
import type { BackupService } from '../backup/backup-service.js';
import { errorMessage, type Logger } from '../log.js';
import type { ServerManager } from '../minecraft/server-manager.js';
import { isPortFree } from '../platform/ports.js';
import { freeBytes } from '../util/disk.js';
import type { JavaRegistry } from '../platform/java.js';
import type { StateStore } from '../state/store.js';
import type { TaskContext } from '../tasks/runner.js';
import { downloadWithResume } from '../util/download.js';

const MARKER = '.mmo-server.json';
export const MIGRATED_PURGE_MS = 7 * 24 * 3600_000;

export interface AgentMigrationOptions {
  stateDir: string;
  store: StateStore;
  manager: ServerManager;
  backups: BackupService;
  java: JavaRegistry;
  logger: Logger;
  panelOrigin: () => string | undefined;
  fetchImpl?: typeof fetch | undefined;
  now?: () => number;
  /** Adresses à annoncer par `transfer.serve` (tests : `127.0.0.1`) ; défaut : adresses privées. */
  serveAddresses?: () => string[];
}

interface Served {
  servers: http.Server[];
  timer: ReturnType<typeof setTimeout>;
  token: string;
}

export type MigrationExportRequest = Omit<ParsedRequestPayload<'migration.export'>, 'taskId'>;
export type MigrationImportRequest = Omit<ParsedRequestPayload<'migration.import'>, 'taskId'>;

export class AgentMigration {
  private readonly served = new Map<string, Served>();
  /** Phase 12 : chemins exportés par migration (`migrationId` → dossier), seuls renommables au finalize. */
  private readonly exported = new Map<string, string>();
  private readonly now: () => number;

  constructor(private readonly options: AgentMigrationOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  get activeServes(): number {
    return this.served.size;
  }

  // --- Source : export -------------------------------------------------------------------------

  /** Exécuteur de `migration.export` : serveur arrêté proprement puis backup `pre_migration`. */
  async exportServer(
    req: MigrationExportRequest,
    ctx: TaskContext,
  ): Promise<BackupManifest & { wasRunning: boolean; durationMs: number }> {
    const startedAt = this.now();
    if (!this.options.store.getServer(req.serverId)) {
      throw new ProtocolError('E_NOT_FOUND', `unknown server ${req.serverId}`);
    }
    const exportedPath = this.options.store.getServer(req.serverId)?.config.path;
    if (exportedPath !== undefined) {
      this.exported.set(req.migrationId, path.resolve(exportedPath));
    }
    const wasRunning = this.options.manager.get(req.serverId)?.isRunning ?? false;
    if (wasRunning) {
      ctx.progress('stopping', 0);
      await this.options.manager.stop(req.serverId, {
        forceAfterTimeout: true,
        ...(req.announce === undefined ? {} : { announce: req.announce }),
        ...(req.stopTimeoutSec === undefined ? {} : { timeoutMs: req.stopTimeoutSec * 1000 }),
      });
    }
    ctx.throwIfCancelled();
    const manifest = await this.options.backups.create(
      {
        serverId: req.serverId,
        backupId: req.backupId,
        kind: 'pre_migration',
        ...(req.codec === undefined ? {} : { codec: req.codec }),
        ...(req.destination === undefined ? {} : { destination: req.destination }),
        comment: `migration ${req.migrationId}`,
      },
      ctx,
    );
    return { ...manifest, wasRunning, durationMs: this.now() - startedAt };
  }

  // --- Source : listener one-shot -------------------------------------------------------------

  async serve(
    req: ParsedRequestPayload<'transfer.serve'>,
  ): Promise<{ urls: string[]; size: number; sha256: string; expiresAt: number }> {
    const manifest = await this.options.backups.find(req.serverId, req.backupId);
    const st = await stat(manifest.archivePath);
    const existing = this.served.get(req.token);
    if (existing) this.closeServe(req.token);
    const addresses = this.options.serveAddresses?.() ?? privateAddresses();
    if (addresses.length === 0) {
      throw new ProtocolError('E_UNREACHABLE', 'no private address to serve on', {
        retryable: false,
      });
    }
    const servers: http.Server[] = [];
    const urls: string[] = [];
    const fileName = path.basename(manifest.archivePath);
    for (const address of addresses) {
      const server = http.createServer((request, response) => {
        this.handleServe(request, response, req.token, manifest.archivePath, st.size, fileName);
      });
      server.keepAliveTimeout = 5_000;
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(0, address, () => {
            server.off('error', reject);
            resolve();
          });
        });
      } catch (error) {
        this.options.logger.warn('transfer.serve: cannot listen', {
          address,
          error: errorMessage(error),
        });
        continue;
      }
      const port = (server.address() as AddressInfo).port;
      const host = address.includes(':') ? `[${address}]` : address;
      urls.push(`http://${host}:${String(port)}/${req.token}`);
      servers.push(server);
    }
    if (servers.length === 0) {
      throw new ProtocolError('E_IO', 'transfer.serve: no listener could be opened');
    }
    const ttlMs = req.ttlSec * 1000;
    const timer = setTimeout(() => {
      this.closeServe(req.token);
    }, ttlMs);
    timer.unref();
    this.served.set(req.token, { servers, timer, token: req.token });
    return { urls, size: st.size, sha256: manifest.sha256, expiresAt: this.now() + ttlMs };
  }

  private handleServe(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    token: string,
    file: string,
    size: number,
    fileName: string,
  ): void {
    const url = request.url ?? '';
    if (url !== `/${token}` || (request.method !== 'GET' && request.method !== 'HEAD')) {
      response.writeHead(404).end();
      return;
    }
    let start = 0;
    let end = size - 1;
    const range = request.headers.range;
    if (range !== undefined) {
      const m = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (!m) {
        response.writeHead(416, { 'Content-Range': `bytes */${String(size)}` }).end();
        return;
      }
      start = Number(m[1]);
      if (m[2] !== '') end = Math.min(Number(m[2]), size - 1);
      if (start >= size) {
        response.writeHead(416, { 'Content-Range': `bytes */${String(size)}` }).end();
        return;
      }
    }
    const headers: Record<string, string> = {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
      'Content-Disposition': `attachment; filename="${fileName}"`,
    };
    if (range !== undefined) {
      headers['Content-Range'] = `bytes ${String(start)}-${String(end)}/${String(size)}`;
    }
    response.writeHead(range === undefined ? 200 : 206, headers);
    if (request.method === 'HEAD' || size === 0) {
      response.end();
      return;
    }
    const stream = createReadStream(file, { start, end, highWaterMark: 1024 * 1024 });
    stream.pipe(response);
    stream.on('error', () => {
      response.destroy();
    });
    response.on('close', () => {
      stream.destroy();
      // Transfert complet : le listener ne sert qu'une fois (le panel rejoue `transfer.serve` si besoin).
      if (response.writableFinished && end === size - 1) {
        setTimeout(() => {
          this.closeServe(token);
        }, 2_000).unref();
      }
    });
  }

  closeServe(token: string): void {
    const s = this.served.get(token);
    if (!s) return;
    clearTimeout(s.timer);
    for (const server of s.servers) server.close();
    this.served.delete(token);
  }

  closeAll(): void {
    for (const token of [...this.served.keys()]) this.closeServe(token);
  }

  // --- Cible : pré-checks -----------------------------------------------------------------------

  async precheck(
    req: ParsedRequestPayload<'migration.precheck'>,
  ): Promise<MigrationPrecheckResult> {
    const target = path.resolve(req.path);
    const pathCheck = await checkPath(target);
    const port =
      req.gamePort === undefined
        ? { ok: true }
        : (await isPortFree(req.gamePort))
          ? { ok: true }
          : { ok: false, code: 'port_in_use', detail: { port: req.gamePort } };
    let java: MigrationPrecheckResult['java'] = { ok: true };
    if (req.javaMajor !== undefined) {
      const runtime = await this.options.java.select({
        majorVersion: req.javaMajor,
        strict: req.javaStrict ?? false,
      });
      java = runtime
        ? { ok: true, runtime }
        : {
            ok: false,
            code: 'java_missing',
            installable: true,
            detail: { majorVersion: req.javaMajor, strict: req.javaStrict ?? false },
          };
    }
    const free = await freeBytes(target);
    const disk =
      free === undefined
        ? { ok: true }
        : free >= req.requiredBytes
          ? { ok: true, freeBytes: free, requiredBytes: req.requiredBytes }
          : {
              ok: false,
              code: 'disk_full',
              freeBytes: free,
              requiredBytes: req.requiredBytes,
            };
    return { ok: pathCheck.ok && port.ok && java.ok && disk.ok, path: pathCheck, port, java, disk };
  }

  // --- Cible : import ---------------------------------------------------------------------------

  /** Exécuteur de `migration.import`. */
  async importServer(
    req: MigrationImportRequest,
    ctx: TaskContext,
  ): Promise<{
    serverId: string;
    path: string;
    files: number;
    bytes: number;
    source: 'direct' | 'relay';
    started: boolean;
  }> {
    const target = path.resolve(req.config.path);
    const serverId = req.config.serverId;
    const pathCheck = await checkPath(target);
    if (!pathCheck.ok && this.options.store.getServer(serverId)?.config.path !== target) {
      throw new ProtocolError('E_PRECHECK_FAILED', 'target directory is not empty', {
        details: { checks: { path: pathCheck } },
      });
    }
    const staging = path.join(this.options.stateDir, 'migrations', sanitize(req.migrationId));
    await mkdir(staging, { recursive: true });
    const archive = path.join(staging, path.basename(req.manifest.archivePath));
    const partPath = `${archive}.part`;
    ctx.artifact(staging);
    await ctx.checkpoint();

    ctx.progress('downloading', 0);
    const sources = req.sources.map((s) => ({ url: s.url, headers: s.headers, kind: s.kind }));
    let source: 'direct' | 'relay' = 'direct';
    if (!(await exists(archive))) {
      const result = await downloadWithResume({
        partPath,
        sources,
        panelOrigin: this.options.panelOrigin(),
        sha256: req.manifest.sha256,
        size: req.manifest.sizeBytes,
        signal: ctx.signal,
        fetchImpl: this.options.fetchImpl,
        ...(req.connectTimeoutMs === undefined ? {} : { connectTimeoutMs: req.connectTimeoutMs }),
        onProgress: (received, total, index) => {
          const kind = req.sources[index]?.kind ?? 'direct';
          ctx.progress(
            'downloading',
            total === undefined || total === 0 ? undefined : Math.min(60, (received / total) * 60),
            `${kind} ${String(Math.round(received / 1048576))} MiB`,
          );
        },
      });
      source = req.sources[result.sourceIndex]?.kind ?? 'direct';
      await rename(partPath, archive);
    }
    ctx.throwIfCancelled();
    ctx.progress('verifying', 60);
    const check = await verifyArchive(archive, req.manifest, {
      shouldAbort: () => ctx.isCancelled,
    });
    if (!check.ok) {
      await rm(archive, { force: true });
      throw new ProtocolError('E_CHECKSUM_MISMATCH', 'archive does not match its manifest', {
        details: { expectedSha256: req.manifest.sha256, actualSha256: check.sha256 },
      });
    }
    ctx.throwIfCancelled();
    // À partir d'ici le dossier cible est créé : il est nettoyé si la task échoue.
    await mkdir(target, { recursive: true });
    ctx.artifact(target);
    await ctx.checkpoint();
    ctx.progress('extracting', 65);
    let extracted: { files: number; bytes: number };
    try {
      extracted = await extractArchive(archive, req.manifest.codec, target, {
        shouldAbort: () => ctx.isCancelled,
        onProgress: (p) => {
          ctx.progress(
            'extracting',
            65 + (p.bytes / Math.max(1, req.manifest.bytesRaw)) * 30,
            p.current,
          );
        },
      });
    } catch (error) {
      if (ctx.isCancelled) throw new ProtocolError('E_CANCELLED', 'import cancelled');
      throw new ProtocolError('E_IO', `extraction failed: ${errorMessage(error)}`, {
        cause: error,
      });
    }
    ctx.progress('registering', 96);
    await this.options.manager.upsertConfig({ ...req.config, path: target });
    ctx.keep(target);
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    ctx.keep(staging);
    let started = false;
    if (req.startAfter) {
      ctx.progress('starting', 98);
      try {
        await this.options.manager.start(serverId);
        started = true;
      } catch (error) {
        this.options.logger.warn('start after import failed', {
          serverId,
          error: errorMessage(error),
        });
      }
    }
    return {
      serverId,
      path: target,
      files: extracted.files,
      bytes: extracted.bytes,
      source,
      started,
    };
  }

  // --- Source : finalisation --------------------------------------------------------------------

  async finalize(
    req: ParsedRequestPayload<'migration.finalize'>,
  ): Promise<{ path: string; renamed: boolean; purgeAfter?: number }> {
    const source = path.resolve(req.path);
    // Phase 12 : seul le dossier enregistré pour ce serveur — ou exporté pour cette migration
    // (le panel a déjà retiré le serveur de cette machine quand il finalise) — peut être renommé/purgé.
    const known = this.options.store.serverConfigs().find((c) => c.serverId === req.serverId);
    const exportedFor = this.exported.get(req.migrationId);
    const allowed =
      (known !== undefined && path.resolve(known.path) === source) || exportedFor === source;
    if (!allowed) {
      throw new ProtocolError('E_NOT_FOUND', 'unknown server or path mismatch for finalize', {
        details: { serverId: req.serverId, path: req.path },
      });
    }
    const proc = this.options.manager.get(req.serverId);
    if (proc?.isRunning) {
      throw new ProtocolError('E_BUSY', 'server is still running on the source machine');
    }
    // Le serveur n'appartient plus à cette machine.
    const others = this.options.store.serverConfigs().filter((c) => c.serverId !== req.serverId);
    await this.options.manager.applyConfigs(others);
    if (req.action === 'keep' || !(await exists(source))) {
      await rm(path.join(source, MARKER), { force: true }).catch(() => undefined);
      return { path: source, renamed: false };
    }
    this.exported.delete(req.migrationId);
    const renamed = `${source}.migrated-${stamp(this.now())}`;
    // Windows : un processus Java qui vient de s'arrêter peut encore retenir le dossier (EPERM/EBUSY)
    // pendant quelques instants — on insiste, puis on laisse le dossier en place (marqueur retiré).
    let done = false;
    for (let attempt = 0; attempt < 10 && !done; attempt++) {
      try {
        await rename(source, renamed);
        done = true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if ((code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') || attempt === 9) {
          this.options.logger.warn('migrated dir rename failed, keeping it in place', {
            path: source,
            error: errorMessage(error),
          });
          await rm(path.join(source, MARKER), { force: true }).catch(() => undefined);
          return { path: source, renamed: false };
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    // Sans marqueur et exclu du scan : jamais redétecté comme serveur.
    await rm(path.join(renamed, MARKER), { force: true }).catch(() => undefined);
    const purgeAfter = this.now() + MIGRATED_PURGE_MS;
    await this.options.store.update((s) => {
      s.migratedDirs.push({ path: renamed, purgeAfter });
    });
    return { path: renamed, renamed: true, purgeAfter };
  }

  /** Purge différée des dossiers `.migrated-*` (appelée avec la purge de la corbeille). */
  async purgeMigrated(): Promise<number> {
    const t = this.now();
    const due = this.options.store.get().migratedDirs.filter((d) => d.purgeAfter <= t);
    if (due.length === 0) return 0;
    for (const d of due) {
      await rm(d.path, { recursive: true, force: true, maxRetries: 3 }).catch((error: unknown) => {
        this.options.logger.warn('migrated dir purge failed', {
          path: d.path,
          error: errorMessage(error),
        });
      });
    }
    await this.options.store.update((s) => {
      s.migratedDirs = s.migratedDirs.filter((d) => d.purgeAfter > t);
    });
    return due.length;
  }
}

// --- Utilitaires -----------------------------------------------------------------------------------

async function checkPath(
  target: string,
): Promise<{ ok: boolean; code?: string; detail?: Record<string, unknown> }> {
  const st = await stat(target).catch(() => undefined);
  if (!st) {
    // Le parent doit exister (ou être créable) : on ne crée pas d'arborescence arbitraire.
    const parent = await stat(path.dirname(target)).catch(() => undefined);
    return parent?.isDirectory()
      ? { ok: true }
      : { ok: false, code: 'parent_missing', detail: { parent: path.dirname(target) } };
  }
  if (!st.isDirectory()) return { ok: false, code: 'path_is_file' };
  const entries = await readdir(target).catch(() => undefined);
  if (entries === undefined) return { ok: false, code: 'path_unreadable' };
  return entries.length === 0 ? { ok: true } : { ok: false, code: 'path_not_empty' };
}

/** Adresses privées (RFC 1918, ULA fd00::/8, link-local exclue) des interfaces actives. */
export function privateAddresses(): string[] {
  const out: string[] = [];
  for (const [, infos] of Object.entries(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.internal) continue;
      if (info.family === 'IPv4') {
        if (isPrivateV4(info.address)) out.push(info.address);
      } else {
        const a = info.address.toLowerCase();
        if (a.startsWith('fd') || a.startsWith('fc')) out.push(a.split('%')[0] ?? a);
      }
    }
  }
  return out;
}

function isPrivateV4(address: string): boolean {
  const [a, b] = address.split('.').map(Number);
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true;
  if (a === 100 && b !== undefined && b >= 64 && b <= 127) return true; // CGNAT / Tailscale
  return false;
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

function stamp(t: number): string {
  const d = new Date(t);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${String(d.getFullYear())}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function sanitize(id: string): string {
  return id.replace(/[^A-Za-z0-9_.-]/g, '_');
}

export function newTransferToken(): string {
  return randomBytes(16).toString('hex');
}
