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
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  ProtocolError,
  type DetectedServer,
  type JavaRuntime,
  type Os,
  type InstallStep,
  type ParsedRequestPayload,
  type ServerInstallResult,
} from '@mmo/protocol';
import { detectServer, type DetectFs } from '@mmo/shared';
import { createNodeDetectFs } from '@mmo/shared/node';

import type { ForbiddenRoots } from '../files/forbidden.js';
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
  /** Lancement d'un processus (tests : faux java). */
  spawnImpl?: typeof spawn | undefined;
}

/** Fenêtre de sortie conservée d'un `runJar` : assez pour diagnostiquer, jamais pour saturer. */
export const RUN_OUTPUT_LINES = 200;
const RUN_OUTPUT_MAX_CHARS = 8000;
/** Fichiers tolérés dans un dossier « vide » : le marqueur que l'agent vient d'y écrire. */
const IGNORED_WHEN_EMPTY = new Set(['.mmo-server.json']);

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
    }
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
