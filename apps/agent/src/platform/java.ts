/**
 * Découverte des runtimes Java (doc 03 §4, `java.list`) : JAVA_HOME, PATH, emplacements usuels par
 * OS, dossier géré par l'agent. Version lue via `java -version` (stderr), mise en cache par chemin.
 */
import { execFile } from 'node:child_process';
import { access, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { JavaRuntime } from '@mmo/protocol';

export interface JavaRequirementLike {
  majorVersion: number;
  strict: boolean;
}

const exe = process.platform === 'win32' ? 'java.exe' : 'java';

/** Candidats de répertoires racine (un JDK/JRE par sous-dossier). */
function candidateRoots(managedDir: string | undefined): string[] {
  const roots: string[] = [];
  if (managedDir !== undefined) roots.push(managedDir);
  if (process.platform === 'win32') {
    {
      const pf = process.env.ProgramFiles ?? 'C:\\Program Files';
      const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
      for (const base of [pf, pf86]) {
        for (const vendor of [
          'Java',
          'Eclipse Adoptium',
          'Eclipse Foundation',
          'Zulu',
          'Microsoft',
          'Amazon Corretto',
          'BellSoft',
          'AdoptOpenJDK',
          'OpenJDK',
        ]) {
          roots.push(path.join(base, vendor));
        }
      }
    }
  } else if (process.platform === 'darwin') {
    roots.push('/Library/Java/JavaVirtualMachines', '/opt/homebrew/opt', '/usr/local/opt');
  } else {
    roots.push('/usr/lib/jvm', '/usr/java', '/opt/java', '/opt/jdk', '/usr/local/lib/jvm');
  }
  return roots;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Chemins d'exécutables java plausibles (dédupliqués, existants). */
export async function findJavaExecutables(managedDir?: string): Promise<string[]> {
  const found = new Set<string>();
  const add = async (home: string): Promise<void> => {
    for (const rel of [
      path.join('bin', exe),
      path.join('Contents', 'Home', 'bin', exe),
      path.join('jre', 'bin', exe),
    ]) {
      const p = path.join(home, rel);
      if (await exists(p)) {
        found.add(path.normalize(p));
        return;
      }
    }
  };
  const javaHome = process.env.JAVA_HOME;
  if (javaHome !== undefined && javaHome !== '') await add(javaHome);
  for (const root of candidateRoots(managedDir)) {
    let entries: string[];
    try {
      entries = (await readdir(root, { withFileTypes: true }))
        .filter((e) => e.isDirectory() || e.isSymbolicLink())
        .map((e) => e.name);
    } catch {
      continue;
    }
    for (const name of entries) await add(path.join(root, name));
  }
  // `java` du PATH
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir === '') continue;
    const p = path.join(dir, exe);
    if (await exists(p)) found.add(path.normalize(p));
  }
  return [...found];
}

export interface JavaVersionInfo {
  majorVersion: number;
  fullVersion: string;
  vendor: string;
}

/** Interprète la sortie de `java -version` (stderr) : `"1.8.0_281"` → 8, `"17.0.5"` → 17. */
export function parseJavaVersionOutput(output: string): JavaVersionInfo | undefined {
  const m = /version "([^"]+)"/.exec(output);
  if (!m) return undefined;
  const full = m[1] ?? '';
  const parts = full.split(/[._-]/);
  const first = Number(parts[0]);
  const major = first === 1 ? Number(parts[1]) : first;
  if (!Number.isInteger(major) || major <= 0) return undefined;
  const lower = output.toLowerCase();
  const vendor = lower.includes('temurin')
    ? 'temurin'
    : lower.includes('zulu')
      ? 'zulu'
      : lower.includes('corretto')
        ? 'corretto'
        : lower.includes('microsoft')
          ? 'microsoft'
          : lower.includes('graalvm')
            ? 'graalvm'
            : lower.includes('openjdk')
              ? 'openjdk'
              : lower.includes('java(tm)')
                ? 'oracle'
                : 'unknown';
  return { majorVersion: major, fullVersion: full, vendor };
}

export function probeJavaVersion(javaPath: string): Promise<JavaVersionInfo | undefined> {
  return new Promise((resolve) => {
    execFile(
      javaPath,
      ['-version'],
      { encoding: 'utf8', timeout: 20_000, windowsHide: true },
      (error, stdout, stderr) => {
        if (error && stderr === '' && stdout === '') {
          resolve(undefined);
          return;
        }
        resolve(parseJavaVersionOutput(`${stderr}\n${stdout}`));
      },
    );
  });
}

export class JavaRegistry {
  private cache = new Map<string, JavaRuntime>();
  private scanned = false;

  constructor(private readonly managedDir?: string) {}

  async list(refresh = false): Promise<JavaRuntime[]> {
    if (!this.scanned || refresh) {
      const paths = await findJavaExecutables(this.managedDir);
      const next = new Map<string, JavaRuntime>();
      for (const p of paths) {
        const cached = this.cache.get(p);
        if (cached) {
          next.set(p, cached);
          continue;
        }
        const info = await probeJavaVersion(p);
        if (!info) continue;
        next.set(p, {
          majorVersion: info.majorVersion,
          fullVersion: info.fullVersion,
          vendor: info.vendor,
          path: p,
          managed: this.managedDir !== undefined && p.startsWith(this.managedDir),
        });
      }
      this.cache = next;
      this.scanned = true;
    }
    return [...this.cache.values()].sort((a, b) => b.majorVersion - a.majorVersion);
  }

  /** Vérifie (et mémorise) un exécutable imposé par l'utilisateur. */
  async probe(javaPath: string): Promise<JavaRuntime | undefined> {
    const p = path.normalize(javaPath);
    const cached = this.cache.get(p);
    if (cached) return cached;
    const info = await probeJavaVersion(p);
    if (!info) return undefined;
    const rt: JavaRuntime = {
      majorVersion: info.majorVersion,
      fullVersion: info.fullVersion,
      vendor: info.vendor,
      path: p,
      managed: false,
    };
    this.cache.set(p, rt);
    return rt;
  }

  /**
   * Sélection : version majeure exacte si disponible ; sinon, hors mode strict, la plus petite
   * version ≥ requise (un JRE plus récent que nécessaire fonctionne généralement, l'inverse jamais).
   */
  async select(requirement: JavaRequirementLike): Promise<JavaRuntime | undefined> {
    const runtimes = await this.list();
    return selectJavaRuntime(runtimes, requirement);
  }
}

export function selectJavaRuntime(
  runtimes: readonly JavaRuntime[],
  requirement: JavaRequirementLike,
): JavaRuntime | undefined {
  const exact = runtimes.filter((r) => r.majorVersion === requirement.majorVersion);
  if (exact.length > 0) return preferManaged(exact);
  if (requirement.strict) return undefined;
  const newer = runtimes
    .filter((r) => r.majorVersion > requirement.majorVersion)
    .sort((a, b) => a.majorVersion - b.majorVersion);
  const lowest = newer[0];
  if (!lowest) return undefined;
  return preferManaged(newer.filter((r) => r.majorVersion === lowest.majorVersion));
}

function preferManaged(runtimes: JavaRuntime[]): JavaRuntime | undefined {
  return runtimes.find((r) => r.managed) ?? runtimes[0];
}

export function defaultManagedJavaDir(stateDir: string): string {
  return path.join(stateDir, 'java');
}

export function totalRamMb(): number {
  return Math.round(os.totalmem() / 1048576);
}
