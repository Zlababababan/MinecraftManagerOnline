/**
 * `mmo-panel doctor` : diagnostic d'une installation, en clair.
 *
 * Motivation : sur une machine où le panel refuse de démarrer, l'utilisateur voyait jusqu'ici une
 * stack Node. Les trois pannes réellement rencontrées à l'installation sont ici couvertes par un
 * contrôle chacune — runtime inadapté, dossier de données appartenant à root après une extraction
 * en `sudo` (le `SQLITE_CANTOPEN` de l'épisode Ubuntu 20.04 ARM), port déjà pris.
 *
 * Les contrôles sont des fonctions pures rendant `{ code, level, message }` : ils servent aussi au
 * démarrage (en avertissements) et au futur bundle de diagnostic. Volontairement court : pas de
 * détection de pare-feu ni de dérive d'horloge — du support de niveau 3 pour un projet qui compte
 * ses utilisateurs sur les doigts d'une main.
 */
import { closeSync, existsSync, mkdirSync, openSync, statSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';

import type { PanelConfig } from './config.js';
import { openSqliteFile } from './db/sqlite.js';
import { PANEL_VERSION } from './version.js';

export type CheckLevel = 'ok' | 'warn' | 'error';

export interface Check {
  code: string;
  level: CheckLevel;
  message: string;
}

/** Version minimale de Node : `node:sqlite` (et `setReturnArrays`) exigent 24. */
export const MIN_NODE_MAJOR = 24;

const require_ = createRequire(import.meta.url);

function glibcVersion(): string | undefined {
  try {
    const { header } = process.report.getReport() as { header?: Record<string, unknown> };
    const value = header?.glibcVersionRuntime;
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

export function checkRuntime(): Check {
  const major = Number(process.versions.node.split('.')[0]);
  const where = `${process.platform}/${process.arch}${glibcVersion() === undefined ? '' : `, glibc ${glibcVersion() ?? ''}`}`;
  if (major < MIN_NODE_MAJOR) {
    return {
      code: 'runtime.too_old',
      level: 'error',
      message:
        `Node ${process.versions.node} is too old (${String(MIN_NODE_MAJOR)}+ required for node:sqlite). ` +
        'Use the runtime shipped in the panel archive (mmo-panel.cmd / ./mmo-panel.sh) instead of a system Node.',
    };
  }
  return {
    code: 'runtime.ok',
    level: 'ok',
    message: `panel ${PANEL_VERSION} on node ${process.versions.node} (${where})`,
  };
}

/** Les modules chargés dynamiquement : un échec ici est la panne d'installation classique. */
export function checkNativeModules(): Check[] {
  const checks: Check[] = [];
  try {
    const { DatabaseSync } = require_('node:sqlite') as {
      DatabaseSync: new (file: string) => {
        prepare: (s: string) => { get: () => unknown };
        close: () => void;
      };
    };
    const db = new DatabaseSync(':memory:');
    const row = db.prepare('SELECT sqlite_version() AS v').get() as { v: string };
    db.close();
    checks.push({ code: 'sqlite.ok', level: 'ok', message: `sqlite ${row.v} (node:sqlite)` });
  } catch (error) {
    checks.push({
      code: 'sqlite.unavailable',
      level: 'error',
      message: `node:sqlite unavailable: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  try {
    const argon2 = require_('@node-rs/argon2') as {
      hashSync: (s: string) => string;
      verifySync: (h: string, s: string) => boolean;
    };
    if (!argon2.verifySync(argon2.hashSync('mmo'), 'mmo')) throw new Error('inconsistent hash');
    checks.push({ code: 'argon2.ok', level: 'ok', message: 'argon2 binding loaded' });
  } catch (error) {
    checks.push({
      code: 'argon2.unavailable',
      level: 'error',
      message:
        `@node-rs/argon2 cannot be loaded: ${error instanceof Error ? error.message : String(error)}. ` +
        'The archive was probably built for another platform or another libc.',
    });
  }
  return checks;
}

/**
 * Écriture RÉELLE dans le dossier de données, et propriétaire comparé au processus : un `statSync`
 * seul ment sous ACL, et c'est précisément le cas « archive extraite en sudo, panel lancé par
 * l'utilisateur » qui produisait un `SQLITE_CANTOPEN` incompréhensible.
 */
export function checkDataDir(dataDir: string): Check {
  try {
    mkdirSync(dataDir, { recursive: true });
  } catch (error) {
    return {
      code: 'data.not_creatable',
      level: 'error',
      message: `cannot create ${dataDir}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const probe = path.join(dataDir, '.mmo-write-test');
  try {
    closeSync(openSync(probe, 'w'));
    unlinkSync(probe);
  } catch (error) {
    const owner = ownerHint(dataDir);
    return {
      code: 'data.not_writable',
      level: 'error',
      message: `${dataDir} is not writable by the current user${owner}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return { code: 'data.ok', level: 'ok', message: `data directory writable: ${dataDir}` };
}

/** Sous POSIX, nomme le propriétaire et donne la commande exacte qui répare. */
function ownerHint(dir: string): string {
  if (process.platform === 'win32' || process.getuid === undefined) return '';
  try {
    const uid = statSync(dir).uid;
    if (uid === process.getuid()) return '';
    return ` (owned by uid ${String(uid)}, running as uid ${String(process.getuid())} — try: sudo chown -R "$USER" "${dir}")`;
  } catch {
    return '';
  }
}

/** `mmo.db` présente : ouverture et `quick_check`. Absente : première installation, rien à dire. */
export function checkDatabase(dataDir: string): Check {
  const file = path.join(dataDir, 'mmo.db');
  if (!existsSync(file)) {
    return { code: 'db.absent', level: 'ok', message: 'mmo.db not created yet (first run)' };
  }
  try {
    const db = openSqliteFile(file);
    try {
      const result = db.pragma('quick_check', { simple: true });
      if (result !== 'ok') {
        return {
          code: 'db.corrupt',
          level: 'error',
          message: `mmo.db failed quick_check: ${String(result)} — restore a backup with: mmo-panel restore <file>`,
        };
      }
    } finally {
      db.close();
    }
    return { code: 'db.ok', level: 'ok', message: 'mmo.db opens and passes quick_check' };
  } catch (error) {
    return {
      code: 'db.unopenable',
      level: 'error',
      message: `cannot open mmo.db: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function checkPort(host: string, port: number): Promise<Check> {
  return new Promise<Check>((resolve) => {
    const server = createServer();
    server.once('error', (error: NodeJS.ErrnoException) => {
      resolve({
        code: error.code === 'EADDRINUSE' ? 'port.in_use' : 'port.unavailable',
        level: 'error',
        message:
          error.code === 'EADDRINUSE'
            ? `${host}:${String(port)} is already in use — another panel is probably running, or set MMO_PORT`
            : `cannot listen on ${host}:${String(port)}: ${error.message}`,
      });
    });
    server.listen(port, host, () => {
      server.close(() => {
        resolve({
          code: 'port.ok',
          level: 'ok',
          message: `${host}:${String(port)} is free`,
        });
      });
    });
  });
}

/** Le front est facultatif (API seule), mais un dossier annoncé et vide est une erreur de déploiement. */
export function checkWebDir(webDir: string | undefined): Check {
  if (webDir === undefined) {
    return { code: 'web.absent', level: 'ok', message: 'no web directory configured (API only)' };
  }
  if (existsSync(path.join(webDir, 'index.html'))) {
    return { code: 'web.ok', level: 'ok', message: `front served from ${webDir}` };
  }
  return {
    code: 'web.empty',
    level: 'warn',
    message: `${webDir} has no index.html: the panel will answer the API but serve no interface`,
  };
}

export async function runChecks(config: PanelConfig): Promise<Check[]> {
  return [
    checkRuntime(),
    ...checkNativeModules(),
    checkDataDir(config.dataDir),
    checkDatabase(config.dataDir),
    await checkPort(config.host, config.port),
    checkWebDir(config.webDir),
  ];
}

const SYMBOL: Record<CheckLevel, string> = { ok: '  ok  ', warn: ' warn ', error: 'ERROR ' };

export function formatChecks(checks: Check[]): string {
  return checks.map((c) => `[${SYMBOL[c.level]}] ${c.message}`).join('\n');
}

/** Sortie 0 si aucun contrôle en erreur. */
export async function doctor(config: PanelConfig): Promise<number> {
  const checks = await runChecks(config);
  console.log(formatChecks(checks));
  const errors = checks.filter((c) => c.level === 'error').length;
  console.log(
    errors === 0
      ? '\nno blocking problem found.'
      : `\n${String(errors)} blocking problem(s) — the panel will not start until they are fixed.`,
  );
  return errors === 0 ? 0 : 1;
}

/** Renvoi utilisé par les messages d'erreur de démarrage. */
export const DOCTOR_HINT = 'run `mmo-panel doctor` for a full diagnosis';
