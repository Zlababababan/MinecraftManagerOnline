/**
 * `mmo-panel report` : le fichier de diagnostic que le formulaire d'issue réclame.
 *
 * Sans lui, le formulaire demande à l'utilisateur ce qu'il ne sait pas produire — version des
 * agents, architecture des deux côtés, mode d'accès, extrait de journal — et c'est exactement
 * l'épisode « Start internal error » sur la VM Oracle, où trois échanges ont servi à obtenir ce que
 * la machine savait déjà.
 *
 * **Un fichier texte, pas une archive.** L'audit proposait un zip ; un texte lisible vaut mieux ici
 * pour une raison qui l'emporte : l'utilisateur va publier ce fichier sur une issue publique, et il
 * doit pouvoir le RELIRE avant. Une archive décourage exactement ça. Accessoirement, le panel n'a
 * aucun écrivain zip et n'a pas à en gagner un pour cette commande.
 *
 * Les secrets ne sont jamais écrits : les réglages passent par la même liste `SECRET_KEYS` que
 * l'API (une seconde liste divergerait), et les lignes de journal sont masquées (chemins
 * personnels, jetons, codes d'appairage, adresses IP tronquées).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { PanelConfig } from './config.js';
import { openSqliteFile } from './db/sqlite.js';
import { formatChecks, runChecks } from './doctor.js';
import { SECRET_KEYS } from './services/settings.js';
import { maskLine } from './util/mask.js';
import { PANEL_VERSION } from './version.js';

const DEFAULT_LOG_LINES = 200;

export interface ReportOptions {
  /** Fichier de sortie ; défaut `<dataDir>/mmo-report-<horodatage>.txt`. */
  out?: string;
  /** Écrire sur la sortie standard au lieu d'un fichier. */
  stdout?: boolean;
  logLines?: number;
  /** Ne joindre aucun extrait de journal. */
  noLog?: boolean;
}

/** Le masquage vit dans `util/mask.ts` (partagé avec le diagnostic d'agent) ; ré-exporté pour les tests. */
export { maskLine };

/** Les `n` dernières lignes du journal du jour le plus récent, masquées. */
function recentLog(dataDir: string, lines: number): string {
  const logsDir = path.join(dataDir, 'logs');
  if (!existsSync(logsDir)) return 'no log directory yet.';
  const files = readdirSync(logsDir)
    .filter((f) => f.startsWith('panel-') && f.endsWith('.log'))
    .sort();
  const latest = files.at(-1);
  if (latest === undefined) return 'no log file yet.';
  const content = readFileSync(path.join(logsDir, latest), 'utf8').split('\n').filter(Boolean);
  const tail = content.slice(-lines);
  return [
    `file: logs/${latest} (${String(content.length)} lines, last ${String(tail.length)} shown, masked)`,
    '',
    ...tail,
  ].join('\n');
}

/**
 * Une colonne SQLite telle qu'elle arrive : le typer précisément (plutôt que `unknown`) est ce qui
 * rend `String(cellule)` acceptable — sur un `Record<string, unknown>`, le lint refuse aussi bien
 * la notation pointée que la conversion en chaîne (piège connu du projet).
 */
type Cell = string | number | null;
type Row = Record<string, Cell>;

/** Lecture SQL directe : ni Drizzle ni migration — la commande doit tourner panel allumé. */
function query(file: string, sql: string): Row[] {
  const db = openSqliteFile(file);
  try {
    return db.prepare(sql).all() as Row[];
  } finally {
    db.close();
  }
}

function table(rows: Row[], columns: string[]): string {
  if (rows.length === 0) return '(none)';
  const width = columns.map((c) =>
    Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)),
  );
  const render = (cells: string[]) => cells.map((v, i) => v.padEnd(width[i] ?? 0)).join('  ');
  return [
    render(columns),
    render(width.map((w) => '-'.repeat(w))),
    ...rows.map((r) => render(columns.map((c) => String(r[c] ?? '')))),
  ].join('\n');
}

function iso(value: Cell): string {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : '';
}

function machinesSection(dbFile: string): string {
  const rows = query(
    dbFile,
    `SELECT name, os, arch, agent_version, protocol_version, runtime_version, status, last_seen_at,
            CASE WHEN panel_url IS NULL THEN '' ELSE 'yes' END AS own_url
     FROM machines ORDER BY name`,
  ).map((r) => ({ ...r, last_seen_at: iso(r.last_seen_at ?? null) }));
  return table(rows, [
    'name',
    'os',
    'arch',
    'agent_version',
    'protocol_version',
    'runtime_version',
    'status',
    'last_seen_at',
    'own_url',
  ]);
}

/**
 * Les serveurs sans leur chemin : un dossier porte presque toujours le nom de l'utilisateur, et le
 * support n'en a pas besoin — le loader, la version et l'état suffisent à comprendre une panne.
 */
function serversSection(dbFile: string): string {
  const rows = query(
    dbFile,
    `SELECT s.name, m.name AS machine, s.loader, s.mc_version, s.provisioning, s.desired_state,
            s.run_state, s.port, s.rcon_enabled, s.detected
     FROM servers s LEFT JOIN machines m ON m.id = s.machine_id
     ORDER BY m.name, s.name`,
  );
  return table(rows, [
    'name',
    'machine',
    'loader',
    'mc_version',
    'provisioning',
    'desired_state',
    'run_state',
    'port',
    'rcon_enabled',
    'detected',
  ]);
}

function settingsSection(dbFile: string): string {
  const all = query(dbFile, 'SELECT key, value FROM app_settings ORDER BY key');
  const rows = all
    .filter((r) => !SECRET_KEYS.has(String(r.key)))
    .map((r) => ({ key: String(r.key), value: String(r.value ?? '') }));
  const secrets = all
    .filter((r) => SECRET_KEYS.has(String(r.key)))
    .map((r) => ({
      key: String(r.key),
      value: String(r.value ?? '') === '' ? '(not set)' : '(set, hidden)',
    }));
  return table([...rows, ...secrets], ['key', 'value']);
}

/**
 * Masque un bloc entier. On l'applique à ce qui vient de l'hôte — en-tête, sortie du doctor,
 * journal — mais JAMAIS aux tableaux construits depuis la base : la clé de réglage
 * `access.dns.token` y ressemble à un secret, et le masque effacerait le « (set, hidden) » qui est
 * précisément l'information utile.
 */
function masked(block: string): string {
  return block.split('\n').map(maskLine).join('\n');
}

/** Rend le rapport complet. Séparé de l'écriture : c'est ce que testent les tests. */
export async function buildReport(
  config: PanelConfig,
  options: ReportOptions = {},
): Promise<string> {
  const dbFile = path.join(config.dataDir, 'mmo.db');
  const hasDb = existsSync(dbFile);
  const parts: string[] = [];

  parts.push(
    masked(
      [
        '# MinecraftManagerOnline — diagnostic report',
        '',
        'Attach this file to your issue. Read it first: it describes your installation, and you are',
        'the one publishing it. Secrets are never included; personal paths, tokens, pairing codes',
        'and addresses are masked.',
        '',
        `generated at   ${new Date().toISOString()}`,
        `panel version  ${PANEL_VERSION}`,
        `node           ${process.versions.node}`,
        `platform       ${process.platform}/${process.arch}`,
        `os             ${os.type()} ${os.release()}`,
        `cpus / memory  ${String(os.cpus().length)} / ${String(Math.round(os.totalmem() / 1024 / 1024))} MB`,
        `data directory ${config.dataDir}`,
        `listen         ${config.host}:${String(config.port)}`,
        `web directory  ${config.webDir ?? '(none: API only)'}`,
      ].join('\n'),
    ),
  );

  const checks = await runChecks(config);
  parts.push(
    masked(
      [
        '## Diagnosis (mmo-panel doctor)',
        '',
        'Taken right now: if the panel is running, the port being "already in use" is expected.',
        '',
        formatChecks(checks),
      ].join('\n'),
    ),
  );

  if (hasDb) {
    parts.push(['## Machines and agents', '', machinesSection(dbFile)].join('\n'));
    parts.push(['## Servers (paths deliberately omitted)', '', serversSection(dbFile)].join('\n'));
    parts.push(['## Settings (secrets excluded)', '', settingsSection(dbFile)].join('\n'));
  } else {
    parts.push('## Database\n\nmmo.db does not exist yet: nothing to report from it.');
  }

  if (options.noLog !== true) {
    parts.push(
      masked(
        [
          '## Recent log',
          '',
          recentLog(config.dataDir, options.logLines ?? DEFAULT_LOG_LINES),
        ].join('\n'),
      ),
    );
  }

  return `${parts.join('\n\n')}\n`;
}

function parseArgs(argv: string[]): ReportOptions | { error: string } {
  const options: ReportOptions = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--stdout') options.stdout = true;
    else if (arg === '--no-log') options.noLog = true;
    else if (arg === '--out') {
      const value = argv[i + 1];
      if (value === undefined) return { error: '--out expects a file path' };
      options.out = value;
      i += 1;
    } else if (arg === '--log-lines') {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value < 0) return { error: '--log-lines expects a number' };
      options.logLines = value;
      i += 1;
    } else return { error: `unknown option: ${String(arg)}` };
  }
  return options;
}

export async function runReportCommand(config: PanelConfig, argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if ('error' in parsed) {
    console.error(
      `${parsed.error}\nusage: mmo-panel report [--out <file>] [--stdout] [--log-lines <n>] [--no-log]`,
    );
    return 2;
  }
  const report = await buildReport(config, parsed);
  if (parsed.stdout === true) {
    console.log(report);
    return 0;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = parsed.out ?? path.join(config.dataDir, `mmo-report-${stamp}.txt`);
  mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
  writeFileSync(target, report);
  console.log(`report written to ${target}`);
  console.log('read it before attaching it to a public issue.');
  return 0;
}
