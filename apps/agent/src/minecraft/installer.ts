/**
 * Lot 5 — exécuteur de `server.install` (doc 05 §6 « Installation », doc 06 §6bis/§6ter). Calqué
 * sur `JavaInstaller` : une task, des phases stables, des téléchargements repris par `Range` et
 * déclarés en artefacts, une annulation coopérative.
 *
 * Trois règles apprises du spike et gardées ici, pas dans la tête de l'appelant :
 *
 * - **`eula.txt` est écrit APRÈS toutes les étapes.** Le lanceur Fabric installe puis démarre le
 *   serveur ; sans EULA il s'arrête de lui-même (mesuré, doc 06 §6ter). L'écrire avant laisserait
 *   un serveur en marche au milieu de son installation.
 * - **La sortie d'un `runJar` ne part pas en console** (7 580 lignes pour NeoForge) : on garde une
 *   fenêtre bornée, qui n'est jointe qu'à un échec.
 * - **Le code de retour du processus fait foi** (0/1) : jamais celui d'un tube (piège 79).
 *
 * En mode `repair`, le dossier existe déjà et n'est **jamais** déclaré en artefact : le nettoyage
 * d'une task en échec ferait un `rm -r` sur des données utilisateur.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  ARCHIVE_TEXT_MAX_BYTES,
  ARCHIVE_TEXT_MAX_FILES,
  ProtocolError,
  type DetectedServer,
  type InstallArchive,
  type InstallArchiveInspection,
  type JavaRuntime,
  type Os,
  type FetchManyFile,
  type InstallStep,
  type ParsedRequestPayload,
  type ServerInstallResult,
} from '@mmo/protocol';
import { detectServer, type DetectFs } from '@mmo/shared';
import { createNodeDetectFs, safeRelative } from '@mmo/shared/node';

import type { ForbiddenRoots } from '../files/forbidden.js';
import { extractZip, listZip, readZipEntry } from '../java/zip.js';
import { errorMessage, type Logger } from '../log.js';
import type { JavaRequirementLike } from '../platform/java.js';
import type { TaskContext } from '../tasks/runner.js';
import { downloadWithResume } from '../util/download.js';
import { withFsErrors } from '../util/fs-error.js';
import { updateProperties } from './properties.js';
import { writeMarker } from './provisioning.js';

export type ServerInstallRequest = Omit<ParsedRequestPayload<'server.install'>, 'taskId'>;

/** Ce que l'installeur demande au registre Java — `JavaRegistry` le satisfait tel quel. */
export interface JavaLookup {
  select(requirement: JavaRequirementLike): Promise<JavaRuntime | undefined>;
  list(): Promise<readonly JavaRuntime[]>;
}

export interface ServerInstallerOptions {
  logger: Logger;
  java: JavaLookup;
  forbidden: ForbiddenRoots;
  /** OS de l'agent (la détection y choisit les scripts de lancement qu'elle examine). */
  os: Os;
  panelOrigin: () => string | undefined;
  fetchImpl?: typeof fetch | undefined;
  detectFs?: DetectFs | undefined;
  /**
   * Répertoires surveillés actifs : une archive n'est lue que posée à la racine de l'un d'eux
   * (sans cela, `extract` et l'inspection liraient n'importe quel fichier de la machine).
   */
  archiveRoots?: (() => readonly { id: string; path: string }[]) | undefined;
  /** Lancement d'un processus (tests : faux java). */
  spawnImpl?: typeof spawn | undefined;
}

/** Fenêtre de sortie conservée d'un `runJar` : assez pour diagnostiquer, jamais pour saturer. */
export const RUN_OUTPUT_LINES = 200;
const RUN_OUTPUT_MAX_CHARS = 8000;
/** Fichiers tolérés dans un dossier « vide » : le marqueur que l'agent vient d'y écrire. */
const IGNORED_WHEN_EMPTY = new Set(['.mmo-server.json']);
/** Un seul dossier de premier niveau portant l'un de ces noms est le CONTENU, pas un englobant. */
const SERVER_FOLDERS = new Set([
  'mods',
  'config',
  'world',
  'libraries',
  'plugins',
  'kubejs',
  'defaultconfigs',
]);
const ARCHIVE_TEXT_RE = /\.(sh|bat|cmd|ps1|txt|ya?ml|properties)$/i;
const ARCHIVE_SCRIPT_RE = /start|run|launch|variables|server-setup/i;

export class ServerInstaller {
  private readonly detectFs: DetectFs;

  constructor(private readonly options: ServerInstallerOptions) {
    this.detectFs = options.detectFs ?? createNodeDetectFs();
  }

  /**
   * Contrôles menés AVANT de démarrer la task : un refus est une réponse à la requête (400 côté
   * panel), pas une task en échec qui laisserait une ligne `install_failed` derrière elle.
   */
  async precheck(req: ServerInstallRequest): Promise<void> {
    this.options.forbidden.assert(req.path, 'install path');
    for (const step of req.steps) {
      if (step.kind === 'writeText' && path.basename(step.path).toLowerCase() === 'eula.txt') {
        throw new ProtocolError('E_INVALID_PAYLOAD', 'eula.txt is written by acceptEula', {
          details: { reason: 'EULA_STEP', path: step.path },
        });
      }
    }
    for (const step of req.steps) {
      if (step.kind === 'extract') await this.assertArchive(step.archive);
    }
    if (req.repair) return;
    const entries = await readdir(req.path).catch((error: unknown) => {
      if ((error as { code?: string }).code === 'ENOENT') return [] as string[];
      throw error;
    });
    const blocking = entries.filter((name) => !IGNORED_WHEN_EMPTY.has(name));
    if (blocking.length > 0) {
      throw new ProtocolError('E_CONFLICT', 'target directory is not empty', {
        details: { reason: 'PATH_NOT_EMPTY', path: req.path, entries: blocking.slice(0, 10) },
      });
    }
  }

  /** Zips posés à la racine des répertoires surveillés (jamais plus profond : pas de parcours). */
  async listArchives(): Promise<InstallArchive[]> {
    const archives: InstallArchive[] = [];
    for (const root of this.options.archiveRoots?.() ?? []) {
      const entries = await readdir(root.path, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.zip')) continue;
        const full = path.join(root.path, entry.name);
        const info = await stat(full).catch(() => undefined);
        if (info === undefined) continue;
        archives.push({
          directoryId: root.id,
          name: entry.name,
          path: full,
          size: info.size,
          modifiedAt: Math.round(info.mtimeMs),
        });
      }
    }
    return archives.sort((a, b) => b.modifiedAt - a.modifiedAt);
  }

  /** Lit le répertoire central et les petits scripts de la racine — rien n'est déplié. */
  async inspectArchive(archive: string): Promise<InstallArchiveInspection> {
    await this.assertArchive(archive);
    const listing = await listZip(archive).catch((error: unknown) => {
      throw archiveUnreadable(error, archive);
    });
    const entries = listing
      .map((e) => ({ ...e, rel: safeRelative(e.name) ?? '' }))
      .filter((e) => e.rel !== '');
    const firsts = new Set(entries.map((e) => e.rel.split('/')[0] ?? ''));
    const only = firsts.size === 1 ? [...firsts][0] : undefined;
    const root =
      only !== undefined &&
      !SERVER_FOLDERS.has(only.toLowerCase()) &&
      entries.every((e) => e.isDir || e.rel.includes('/'))
        ? only
        : '';
    const top = new Map<string, { name: string; entry: string; size: number; isDir: boolean }>();
    let files = 0;
    let bytes = 0;
    for (const e of entries) {
      if (!e.isDir) {
        files++;
        bytes += e.size;
      }
      const parts = e.rel.split('/').slice(root === '' ? 0 : 1);
      const first = parts[0];
      if (first === undefined) continue;
      const isDir = parts.length > 1 || e.isDir;
      if (!top.has(first)) top.set(first, { name: first, entry: e.name, size: e.size, isDir });
    }
    const texts: { name: string; content: string }[] = [];
    const candidates = [...top.values()]
      .filter((t) => !t.isDir && ARCHIVE_TEXT_RE.test(t.name) && t.size <= ARCHIVE_TEXT_MAX_BYTES)
      .sort(
        (a, b) => Number(ARCHIVE_SCRIPT_RE.test(b.name)) - Number(ARCHIVE_SCRIPT_RE.test(a.name)),
      )
      .slice(0, ARCHIVE_TEXT_MAX_FILES);
    for (const c of candidates) {
      const data = await readZipEntry(archive, c.entry, ARCHIVE_TEXT_MAX_BYTES).catch(
        () => undefined,
      );
      if (data !== undefined) texts.push({ name: c.name, content: data.toString('utf8') });
    }
    return {
      files,
      bytes,
      root,
      topLevel: [...top.values()].slice(0, 200).map((t) => (t.isDir ? `${t.name}/` : t.name)),
      texts,
    };
  }

  /** Un zip, un vrai fichier, posé à la racine d'un répertoire surveillé — rien d'autre. */
  private async assertArchive(archive: string): Promise<void> {
    const fold = (p: string): string => {
      const n = path.resolve(p);
      return process.platform === 'win32' ? n.toLowerCase() : n;
    };
    const parent = fold(path.dirname(archive));
    const allowed = (this.options.archiveRoots?.() ?? []).some((r) => fold(r.path) === parent);
    if (!allowed || !archive.toLowerCase().endsWith('.zip')) {
      throw new ProtocolError('E_INVALID_PAYLOAD', 'archive must sit in a watched directory', {
        details: { reason: 'ARCHIVE_OUTSIDE', path: archive },
      });
    }
    const info = await stat(archive).catch(() => undefined);
    if (info?.isFile() !== true) {
      throw new ProtocolError('E_NOT_FOUND', 'archive not found', {
        details: { reason: 'ARCHIVE_MISSING', path: archive },
      });
    }
  }

  /** Exécuteur de la task `server.install`. */
  async install(req: ServerInstallRequest, ctx: TaskContext): Promise<ServerInstallResult> {
    const startedAt = Date.now();
    ctx.progress('preparing', 0);
    await withFsErrors(req.path, () => mkdir(req.path, { recursive: true }));
    // Hors réparation, le dossier a été créé par nous et vide : il peut être défait proprement.
    if (!req.repair) ctx.artifact(req.path);
    await ctx.checkpoint();

    const total = req.steps.length;
    for (let i = 0; i < total; i++) {
      const step = req.steps[i];
      if (step === undefined) continue;
      ctx.throwIfCancelled();
      const base = (i / total) * 90;
      const span = 90 / total;
      await this.runStep(step, req, ctx, base, span);
    }

    ctx.throwIfCancelled();
    // L'EULA en dernier, jamais avant (voir l'en-tête) — et seulement si l'utilisateur l'a acceptée.
    if (req.acceptEula) {
      ctx.progress('writing', 92);
      const eulaFile = path.join(req.path, 'eula.txt');
      const stamp = new Date().toISOString();
      await withFsErrors(eulaFile, () =>
        writeFile(
          eulaFile,
          `# accepted through MinecraftManagerOnline on ${stamp}\neula=true\n`,
          'utf8',
        ),
      );
    }
    await writeMarker(req.path, req.serverId).catch((error: unknown) => {
      this.options.logger.warn('install marker write failed', {
        path: req.path,
        error: errorMessage(error),
      });
    });

    ctx.progress('detecting', 95);
    const detected = await detectServer(this.detectFs, req.path, { os: this.options.os }).catch(
      (error: unknown) => {
        this.options.logger.warn('install detection failed', {
          path: req.path,
          error: errorMessage(error),
        });
        return undefined;
      },
    );
    const { files, bytes } = await measureTree(req.path);
    if (!req.repair) ctx.keep(req.path);
    ctx.progress('done', 100);
    return {
      serverId: req.serverId,
      path: req.path,
      ...(detected === undefined ? {} : { detected: withName(detected, req.path) }),
      steps: total,
      files,
      bytes,
      eulaAccepted: req.acceptEula,
      durationMs: Date.now() - startedAt,
    };
  }

  private async runStep(
    step: InstallStep,
    req: ServerInstallRequest,
    ctx: TaskContext,
    base: number,
    span: number,
  ): Promise<void> {
    if (step.kind === 'fetchMany') {
      await this.fetchMany(step, req, ctx, base, span);
      return;
    }
    if (step.kind === 'extract') {
      await this.extract(step, req, ctx, base, span);
      return;
    }
    const target = path.join(req.path, step.kind === 'runJar' ? step.jar : step.path);
    switch (step.kind) {
      case 'download': {
        const partPath = `${target}.${ctx.taskId}.part`;
        ctx.artifact(partPath);
        await withFsErrors(path.dirname(target), () =>
          mkdir(path.dirname(target), { recursive: true }),
        );
        ctx.progress('downloading', base, step.label ?? step.path);
        const result = await downloadWithResume({
          partPath,
          sources: [
            { url: step.url, kind: 'direct' },
            ...(step.sources ?? []).map((s) => ({
              url: s.url,
              ...(s.headers === undefined ? {} : { headers: s.headers }),
              kind: s.kind ?? ('direct' as const),
            })),
          ],
          panelOrigin: this.options.panelOrigin(),
          ...(step.sha256 === undefined ? {} : { sha256: step.sha256 }),
          ...(step.sha1 === undefined ? {} : { sha1: step.sha1 }),
          ...(step.size === undefined ? {} : { size: step.size }),
          signal: ctx.signal,
          fetchImpl: this.options.fetchImpl,
          // Une reprise après coupure, pas davantage (docs/services-tiers.md).
          retries: 2,
          onProgress: (received, total) => {
            ctx.progress(
              'downloading',
              total === undefined || total === 0
                ? base
                : base + Math.min(span, (received / total) * span),
              `${step.label ?? step.path} — ${String(Math.round(received / 1048576))} MiB`,
            );
          },
        });
        await rm(target, { force: true });
        await withFsErrors(target, () => rename(partPath, target));
        ctx.keep(partPath);
        this.options.logger.info('install file downloaded', {
          path: step.path,
          size: result.size,
        });
        return;
      }
      case 'runJar': {
        ctx.progress('running', base, step.label ?? step.jar);
        await this.runJar(step, req, ctx, base, span);
        return;
      }
      case 'writeText': {
        ctx.progress('writing', base, step.path);
        if (step.ifAbsent && (await exists(target))) return;
        await withFsErrors(target, () => mkdir(path.dirname(target), { recursive: true }));
        await withFsErrors(target, () => writeFile(target, step.content, 'utf8'));
        return;
      }
      case 'setProperties': {
        ctx.progress('writing', base, step.path);
        const current = await readFile(target, 'utf8').catch(() => '');
        await withFsErrors(target, () =>
          writeFile(target, updateProperties(current, step.values), 'utf8'),
        );
        return;
      }
      case 'remove': {
        // `relativePathSchema` a déjà refusé `..` et les chemins absolus ; le chemin vide (le dossier
        // du serveur lui-même) est refusé par le schéma de l'étape.
        ctx.progress('writing', base, step.path);
        await withFsErrors(target, () => rm(target, { recursive: true, force: true }));
        return;
      }
    }
  }

  /**
   * Télécharge les fichiers d'un modpack, quelques-uns à la fois (les petits fichiers dominent :
   * 7 124 pour 1,09 Gio mesurés, doc 06 §6quinquies). Chaque fichier est vérifié par son sha1 et
   * repris par `Range`, avec les miroirs du fournisseur en repli ; le premier échec définitif arrête
   * l'étape (et la task : ses `.part` sont des artefacts). En réparation, un fichier déjà présent
   * avec la bonne empreinte est gardé tel quel.
   */
  private async fetchMany(
    step: Extract<InstallStep, { kind: 'fetchMany' }>,
    req: ServerInstallRequest,
    ctx: TaskContext,
    base: number,
    span: number,
  ): Promise<void> {
    const label = step.label ?? 'modpack';
    const totalBytes = step.files.reduce((sum, f) => sum + f.size, 0);
    let doneBytes = 0;
    let doneFiles = 0;
    let skipped = 0;
    let lastReport = 0;
    const report = (force = false): void => {
      const now = Date.now();
      if (!force && now - lastReport < 250) return;
      lastReport = now;
      ctx.progress(
        'downloading',
        base + (totalBytes === 0 ? span : Math.min(span, (doneBytes / totalBytes) * span)),
        `${label} — ${String(doneFiles)}/${String(step.files.length)}`,
      );
    };
    report(true);
    const queue = [...step.files];
    // Un échec arrête les autres ouvriers : sans cela ils continueraient à télécharger pour une
    // task déjà perdue.
    const state = { failed: false };
    const worker = async (): Promise<void> => {
      for (let file = queue.shift(); file !== undefined && !state.failed; file = queue.shift()) {
        ctx.throwIfCancelled();
        try {
          if (await this.fetchOne(file, req, ctx)) skipped++;
        } catch (error) {
          state.failed = true;
          throw error;
        }
        doneBytes += file.size;
        doneFiles++;
        report();
      }
    };
    const workers = Math.min(step.concurrency, step.files.length);
    // `allSettled` : attendre que les téléchargements en vol se terminent avant de rendre l'échec,
    // sinon le nettoyage de la task passerait avant eux et laisserait des `.part` derrière.
    const settled = await Promise.allSettled(Array.from({ length: workers }, () => worker()));
    const failure = settled.find((r) => r.status === 'rejected');
    if (failure !== undefined) throw failure.reason;
    report(true);
    this.options.logger.info('install files downloaded', {
      files: step.files.length,
      skipped,
      bytes: totalBytes,
    });
  }

  /**
   * Déplie l'archive dans le dossier du serveur. Le marqueur d'une archive (un serveur déjà géré
   * ailleurs) n'est pas posé : il porterait l'identité d'un autre serveur.
   */
  private async extract(
    step: Extract<InstallStep, { kind: 'extract' }>,
    req: ServerInstallRequest,
    ctx: TaskContext,
    base: number,
    span: number,
  ): Promise<void> {
    await this.assertArchive(step.archive);
    const label = step.label ?? path.basename(step.archive);
    let lastReport = 0;
    ctx.progress('extracting', base, label);
    const result = await extractZip(step.archive, req.path, {
      stripComponents: step.strip,
      shouldAbort: () => ctx.isCancelled,
      filter: (rel) => !IGNORED_WHEN_EMPTY.has(rel),
      onProgress: ({ bytes, files }) => {
        const now = Date.now();
        if (now - lastReport < 250) return;
        lastReport = now;
        const ratio = step.size === undefined || step.size === 0 ? 0 : bytes / step.size;
        ctx.progress(
          'extracting',
          base + Math.min(span, ratio * span),
          `${label} — ${String(files)} · ${String(Math.round(bytes / 1048576))} MiB`,
        );
      },
    }).catch((error: unknown) => {
      ctx.throwIfCancelled();
      throw archiveUnreadable(error, step.archive);
    });
    if (result.files === 0) {
      throw new ProtocolError('E_IO', 'archive is empty', {
        details: { reason: 'ARCHIVE_EMPTY', path: step.archive },
      });
    }
    this.options.logger.info('install archive extracted', {
      archive: step.archive,
      files: result.files,
      bytes: result.bytes,
      skipped: result.skipped.length,
    });
  }

  /** Un fichier de `fetchMany` ; rend `true` s'il était déjà là (réparation). */
  private async fetchOne(
    file: FetchManyFile,
    req: ServerInstallRequest,
    ctx: TaskContext,
  ): Promise<boolean> {
    const target = path.join(req.path, file.path);
    if (req.repair && (await sha1IfSize(target, file.size)) === file.sha1.toLowerCase()) {
      return true;
    }
    await withFsErrors(path.dirname(target), () =>
      mkdir(path.dirname(target), { recursive: true }),
    );
    const partPath = `${target}.${ctx.taskId}.part`;
    ctx.artifact(partPath);
    await downloadWithResume({
      partPath,
      sources: [file.url, ...(file.mirrors ?? [])].map((url) => ({ url, kind: 'direct' })),
      panelOrigin: this.options.panelOrigin(),
      sha1: file.sha1,
      size: file.size,
      signal: ctx.signal,
      fetchImpl: this.options.fetchImpl,
      // Aucune relance automatique sur les CDN de mods (docs/services-tiers.md) : un échec arrête
      // l'installation, l'interface le dit, et « Reprendre » garde les fichiers déjà bons.
      retries: 1,
    }).catch((error: unknown) => {
      throw downloadFailure(error, file.path, file.url);
    });
    await rm(target, { force: true });
    await withFsErrors(target, () => rename(partPath, target));
    ctx.keep(partPath);
    return false;
  }

  /**
   * Exécute un JAR dans le dossier du serveur. Non détaché (un installeur doit mourir avec la
   * task), sans shell, sortie capturée sur une fenêtre bornée, code de retour du **processus**.
   */
  private async runJar(
    step: Extract<InstallStep, { kind: 'runJar' }>,
    req: ServerInstallRequest,
    ctx: TaskContext,
    base: number,
    span: number,
  ): Promise<void> {
    const jar = path.join(req.path, step.jar);
    if (!(await exists(jar))) {
      throw new ProtocolError('E_NOT_FOUND', 'jar to run is missing', {
        details: { reason: 'JAR_MISSING', jar: step.jar },
      });
    }
    const java = await this.resolveJava(step.javaMajor);
    const spawnFn = this.options.spawnImpl ?? spawn;
    const child = spawnFn(java, ['-jar', jar, ...step.args], {
      cwd: req.path,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const tail: string[] = [];
    const push = (chunk: Buffer | string): void => {
      for (const line of String(chunk).split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed === '') continue;
        tail.push(trimmed);
        if (tail.length > RUN_OUTPUT_LINES) tail.shift();
        ctx.progress('running', base + span / 2, trimmed.slice(0, 120));
      }
    };
    child.stdout.on('data', push);
    child.stderr.on('data', push);

    const timeoutMs = step.timeoutSec * 1000;
    const run = { timedOut: false };
    const timer = setTimeout(() => {
      run.timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    const onAbort = (): void => {
      child.kill('SIGKILL');
    };
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    let code: number | null;
    try {
      code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (c) => {
          resolve(c);
        });
      });
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onAbort);
    }
    if (ctx.isCancelled) throw new ProtocolError('E_CANCELLED', 'server.install cancelled');
    const output = tail.join('\n').slice(-RUN_OUTPUT_MAX_CHARS);
    if (run.timedOut) {
      throw new ProtocolError('E_TIMEOUT', 'installer did not finish in time', {
        details: { reason: 'RUN_TIMEOUT', jar: step.jar, timeoutSec: step.timeoutSec, output },
      });
    }
    if (code !== 0) {
      throw new ProtocolError('E_IO', 'installer returned a failure', {
        details: { reason: 'RUN_FAILED', jar: step.jar, exitCode: code, output },
      });
    }
    // Le code de retour ne suffit pas : un installeur peut sortir 0 sans avoir rien produit.
    for (const expected of step.expect) {
      if (await exists(path.join(req.path, expected))) continue;
      throw new ProtocolError('E_IO', 'installer produced nothing usable', {
        details: { reason: 'RUN_INCOMPLETE', jar: step.jar, missing: expected, output },
      });
    }
  }

  /** JRE pour un `runJar` : la majeure demandée, sinon n'importe lequel (doc 06 §6bis). */
  private async resolveJava(majorVersion: number | undefined): Promise<string> {
    if (majorVersion !== undefined) {
      const exact = await this.options.java.select({ majorVersion, strict: false });
      if (exact) return exact.path;
    }
    const any = await this.options.java.list();
    const best = [...any].sort((a, b) => b.majorVersion - a.majorVersion)[0];
    if (!best) {
      throw new ProtocolError('E_JAVA_UNAVAILABLE', 'no Java runtime to run the installer', {
        details: { reason: 'NO_JAVA', ...(majorVersion === undefined ? {} : { majorVersion }) },
      });
    }
    return best.path;
  }
}

/** Le nom détecté est celui du dossier ; on le fige ici pour ne pas dépendre du séparateur. */
function withName(detected: DetectedServer, root: string): DetectedServer {
  return { ...detected, name: detected.name === '' ? path.basename(root) : detected.name };
}

async function exists(file: string): Promise<boolean> {
  return (await stat(file).catch(() => undefined)) !== undefined;
}

/** Compte les fichiers et les octets d'un arbre (résultat de la task, jamais une garde). */
async function measureTree(root: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) break;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      files += 1;
      const st = await stat(full).catch(() => undefined);
      bytes += st?.size ?? 0;
    }
  }
  return { files, bytes };
}

/** sha1 d'un fichier s'il existe avec la taille attendue ; `undefined` sinon (rien à relire). */
async function sha1IfSize(file: string, size: number): Promise<string | undefined> {
  const info = await stat(file).catch(() => undefined);
  if (info?.isFile() !== true || info.size !== size) return undefined;
  const hash = createHash('sha1');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/**
 * Un téléchargement raté dit QUEL fichier et QUEL service : l'interface affiche la variante
 * `<code>_DOWNLOAD_FAILED` avec ces deux noms, au lieu d'un « erreur disque ou réseau ».
 */
function downloadFailure(error: unknown, file: string, url: string): unknown {
  if (!(error instanceof ProtocolError) || error.code === 'E_CANCELLED') return error;
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    // URL relative (relais du panel) : on garde le texte tel quel.
  }
  return new ProtocolError(error.code, error.message, {
    retryable: error.retryable,
    details: { ...error.details, reason: 'DOWNLOAD_FAILED', file, host },
  });
}

/** Un zip illisible (tronqué, ZIP64, pas un zip) le dit, au lieu d'une « erreur disque ». */
function archiveUnreadable(error: unknown, archive: string): unknown {
  if (error instanceof ProtocolError) return error;
  return new ProtocolError('E_IO', 'archive cannot be read', {
    details: { reason: 'ARCHIVE_UNREADABLE', path: archive, cause: errorMessage(error) },
  });
}
