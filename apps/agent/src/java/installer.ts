/**
 * `java.install` (phase 9, doc 03 §4) : task qui essaie **dans l'ordre** les sources décidées par le
 * panel (Temurin → Zulu → x64 émulé, puis relais panel). Pour chaque source : téléchargement avec
 * reprise (`Range`), vérification sha256 si fournie, extraction (`zip` ou `tar.gz`, dossier racine
 * aplati) sous `<stateDir>/java/<major>-<vendor>[-x64]/`, sonde `java -version`. Un échec passe à
 * la source suivante ; le résultat indique la source retenue et les échecs précédents.
 * `java.remove` ne supprime que les JRE **gérés** (sous le dossier de l'agent).
 */
import { createReadStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { createGunzip } from 'node:zlib';

import { ProtocolError, type JavaRuntime, type ParsedRequestPayload } from '@mmo/protocol';

import { extractTar } from '../backup/tar.js';
import { errorMessage, type Logger } from '../log.js';
import { probeJavaVersion, type JavaRegistry, type JavaVersionInfo } from '../platform/java.js';
import type { TaskContext } from '../tasks/runner.js';
import { downloadWithResume } from '../util/download.js';
import { extractZip } from './zip.js';

export interface JavaInstallerOptions {
  managedDir: string;
  registry: JavaRegistry;
  logger: Logger;
  panelOrigin: () => string | undefined;
  fetchImpl?: typeof fetch | undefined;
  /** Sonde `java -version` (tests : stub). */
  probe?: (javaPath: string) => Promise<JavaVersionInfo | undefined>;
}

export type JavaInstallRequest = Omit<ParsedRequestPayload<'java.install'>, 'taskId'>;

export interface JavaInstallResult {
  runtime: JavaRuntime;
  sourceIndex: number;
  vendor: JavaInstallRequest['sources'][number]['vendor'];
  emulated: boolean;
  failures: { index: number; code: string; message: string }[];
}

const JAVA_EXE = process.platform === 'win32' ? 'java.exe' : 'java';

export class JavaInstaller {
  constructor(private readonly options: JavaInstallerOptions) {}

  /** Chemin de l'exécutable java d'un JRE installé (`bin/java` ou bundle macOS). */
  static javaExecutable(home: string): string[] {
    return [
      path.join(home, 'bin', JAVA_EXE),
      path.join(home, 'Contents', 'Home', 'bin', JAVA_EXE),
      path.join(home, 'jre', 'bin', JAVA_EXE),
    ];
  }

  installDir(major: number, vendor: string, emulated: boolean): string {
    return path.join(
      this.options.managedDir,
      `${String(major)}-${vendor}${emulated ? '-x64' : ''}`,
    );
  }

  /** Exécuteur de la task `java.install`. */
  async install(req: JavaInstallRequest, ctx: TaskContext): Promise<JavaInstallResult> {
    const failures: JavaInstallResult['failures'] = [];
    const probe = this.options.probe ?? probeJavaVersion;
    await mkdir(this.options.managedDir, { recursive: true });
    for (let index = 0; index < req.sources.length; index++) {
      const source = req.sources[index];
      if (source === undefined) continue;
      ctx.throwIfCancelled();
      const home = this.installDir(req.majorVersion, source.vendor, source.emulated);
      // Déjà installé par une tentative précédente (rejeu) : on sonde et on retourne.
      const existing = await this.findExecutable(home);
      if (existing !== undefined) {
        const info = await probe(existing);
        if (info?.majorVersion === req.majorVersion) {
          const runtime = await this.register(existing, info);
          return {
            runtime,
            sourceIndex: index,
            vendor: source.vendor,
            emulated: source.emulated,
            failures,
          };
        }
        await rm(home, { recursive: true, force: true });
      }
      const downloads = path.join(this.options.managedDir, '.downloads');
      await mkdir(downloads, { recursive: true });
      const partPath = path.join(
        downloads,
        `${String(req.majorVersion)}-${source.vendor}${source.emulated ? '-x64' : ''}.${source.archive}.part`,
      );
      const extractDir = `${home}.extract`;
      ctx.artifact(partPath);
      ctx.artifact(extractDir);
      await ctx.checkpoint();
      try {
        ctx.progress('downloading', 0, `${source.vendor}${source.emulated ? ' (x64)' : ''}`);
        await downloadWithResume({
          partPath,
          sources: [
            { url: source.url, headers: source.headers, kind: source.relay ? 'relay' : 'vendor' },
          ],
          panelOrigin: this.options.panelOrigin(),
          sha256: source.sha256,
          size: source.size,
          signal: ctx.signal,
          fetchImpl: this.options.fetchImpl,
          onProgress: (received, total) => {
            ctx.progress(
              'downloading',
              total === undefined || total === 0
                ? undefined
                : Math.min(60, (received / total) * 60),
              `${String(Math.round(received / 1048576))} MiB`,
            );
          },
        });
        ctx.throwIfCancelled();
        ctx.progress('extracting', 60);
        await rm(extractDir, { recursive: true, force: true });
        await mkdir(extractDir, { recursive: true });
        if (source.archive === 'zip') {
          await extractZip(partPath, extractDir, {
            shouldAbort: () => ctx.isCancelled,
            onProgress: (p) => {
              ctx.progress('extracting', 60 + Math.min(30, p.files / 20), p.current);
            },
          });
        } else {
          const input = createReadStream(partPath, { highWaterMark: 1024 * 1024 });
          const gunzip = createGunzip();
          input.on('error', (error) => gunzip.destroy(error));
          try {
            await extractTar(input.pipe(gunzip) as AsyncIterable<Uint8Array>, extractDir, {
              preserveMode: true,
              symlinks: true,
              shouldAbort: () => ctx.isCancelled,
              onProgress: (p) => {
                ctx.progress('extracting', 60 + Math.min(30, p.files / 20), p.current);
              },
            });
          } finally {
            input.destroy();
          }
        }
        ctx.throwIfCancelled();
        await flattenSingleRoot(extractDir);
        await rm(home, { recursive: true, force: true });
        await rename(extractDir, home);
        ctx.keep(extractDir);
        await rm(partPath, { force: true });
        ctx.keep(partPath);
        ctx.progress('probing', 92);
        const exe = await this.findExecutable(home);
        if (exe === undefined) throw new ProtocolError('E_IO', 'no java executable in archive');
        const info = await probe(exe);
        if (!info) throw new ProtocolError('E_IO', 'java -version failed after extraction');
        if (info.majorVersion !== req.majorVersion) {
          throw new ProtocolError('E_CONFLICT', 'archive does not contain the requested major', {
            details: { expected: req.majorVersion, actual: info.majorVersion },
          });
        }
        const runtime = await this.register(exe, info);
        ctx.progress('done', 100);
        return {
          runtime,
          sourceIndex: index,
          vendor: source.vendor,
          emulated: source.emulated,
          failures,
        };
      } catch (error) {
        if (ctx.isCancelled) throw new ProtocolError('E_CANCELLED', 'java.install cancelled');
        const perr = error instanceof ProtocolError ? error : undefined;
        failures.push({ index, code: perr?.code ?? 'E_IO', message: errorMessage(error) });
        this.options.logger.warn('java source failed', {
          index,
          vendor: source.vendor,
          url: source.url,
          error: errorMessage(error),
        });
        await rm(extractDir, { recursive: true, force: true }).catch(() => undefined);
        await rm(home, { recursive: true, force: true }).catch(() => undefined);
        // Le .part d'une source réessayable est conservé pour la reprise ; sinon supprimé.
        if (perr?.code !== 'E_IO' && perr?.code !== 'E_UNREACHABLE') {
          await rm(partPath, { force: true }).catch(() => undefined);
        }
      }
    }
    throw new ProtocolError('E_JAVA_UNAVAILABLE', 'no source could provide the runtime', {
      retryable: true,
      details: { majorVersion: req.majorVersion, failures },
    });
  }

  /** Supprime un JRE géré (jamais une JVM système). */
  async remove(javaPath: string): Promise<boolean> {
    const managed = path.resolve(this.options.managedDir);
    const resolved = path.resolve(javaPath);
    if (!resolved.startsWith(managed + path.sep)) {
      throw new ProtocolError('E_INVALID_PAYLOAD', 'not a managed runtime', {
        details: { path: javaPath },
      });
    }
    const rel = path.relative(managed, resolved).split(path.sep)[0];
    if (rel === undefined || rel === '' || rel.startsWith('.')) return false;
    const home = path.join(managed, rel);
    const st = await stat(home).catch(() => undefined);
    if (!st?.isDirectory()) return false;
    await rm(home, { recursive: true, force: true });
    await this.options.registry.list(true).catch(() => undefined);
    return true;
  }

  private async findExecutable(home: string): Promise<string | undefined> {
    for (const candidate of JavaInstaller.javaExecutable(home)) {
      const st = await stat(candidate).catch(() => undefined);
      if (st?.isFile()) return candidate;
    }
    return undefined;
  }

  private async register(exe: string, info: JavaVersionInfo): Promise<JavaRuntime> {
    await this.options.registry.list(true).catch(() => undefined);
    return {
      majorVersion: info.majorVersion,
      fullVersion: info.fullVersion,
      vendor: info.vendor,
      path: exe,
      managed: true,
    };
  }
}

/** `dir/<unique-racine>/…` → `dir/…` (archives des fournisseurs : un seul dossier racine). */
async function flattenSingleRoot(dir: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  const only = entries[0];
  if (entries.length !== 1 || !only?.isDirectory()) return;
  const root = path.join(dir, only.name);
  const tmp = `${dir}.root`;
  await rm(tmp, { recursive: true, force: true });
  await rename(root, tmp);
  await rm(dir, { recursive: true, force: true });
  await rename(tmp, dir);
}
