/**
 * État persistant de l'agent : `agent-state.json` (doc 05 §3, §5, §7).
 * - identité et secret (permissions restreintes : chmod 600 / ACL propriétaire Windows) ;
 * - configuration poussée par le panel (répertoires surveillés, serveurs, desired states) ;
 * - runtime des serveurs lancés (PID + heure de démarrage + clé de ligne de commande ⇒ ré-adoption) ;
 * - compteurs `seq` par canal, journal des événements critiques en attente d'`event.ack`.
 * Écriture atomique (fichier temporaire + rename), sérialisée, avec coalescence des demandes.
 */
import { spawn } from 'node:child_process';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import {
  backupScheduleSchema,
  desiredStateSchema,
  serverConfigSchema,
  watchdogPolicySchema,
  watchedDirectorySchema,
  type ServerConfig,
} from '@mmo/protocol';

export const serverRuntimeSchema = z.object({
  pid: z.int().positive(),
  /** Heure de démarrage observée par l'OS si disponible, sinon heure du spawn. */
  startedAt: z.int().nonnegative(),
  /** Fragment distinctif de la ligne de commande (jar, argfile…) pour confirmer l'identité du PID. */
  cmdlineKey: z.string(),
  gamePort: z.int().positive().optional(),
  rconPort: z.int().positive().optional(),
  rconPassword: z.string().optional(),
  javaPath: z.string().optional(),
  /** Mode d'attache courant : `attached` = pipes vivants, `detached` = ré-adopté (RCON + tail de log). */
  attachMode: z.enum(['attached', 'detached']).default('attached'),
});
export type ServerRuntime = z.infer<typeof serverRuntimeSchema>;

export const serverRecordSchema = z.object({
  config: serverConfigSchema,
  /** Présent tant qu'un processus lancé par l'agent est (ou peut être) vivant. */
  runtime: serverRuntimeSchema.optional(),
  /** RCON auto-provisionné (doc 06 §5) : stable entre les démarrages. */
  rcon: z.object({ port: z.int().positive(), password: z.string() }).optional(),
  provisioning: z.string().optional(),
});
export type ServerRecord = z.infer<typeof serverRecordSchema>;

export const pendingEventSchema = z.object({
  id: z.string(),
  type: z.string(),
  payload: z.unknown(),
  ts: z.int().nonnegative(),
});
export type PendingEvent = z.infer<typeof pendingEventSchema>;

export const agentStateSchema = z.object({
  version: z.literal(1),
  panelUrl: z.string().optional(),
  agentId: z.string().optional(),
  agentSecret: z.string().optional(),
  previousSecret: z.object({ secret: z.string(), graceUntil: z.int() }).optional(),
  watchedDirectories: z.array(watchedDirectorySchema).default([]),
  servers: z.record(z.string(), serverRecordSchema).default({}),
  desiredStates: z.record(z.string(), desiredStateSchema).default({}),
  restoreOnBoot: z.boolean().default(false),
  /** Politique watchdog par serveur (phase 7), poussée par `agent.configure.watchdog`. */
  watchdog: z.record(z.string(), watchdogPolicySchema.omit({ serverId: true })).default({}),
  metricsIntervalSec: z.int().positive().default(15),
  /** Phase 8 : destination globale des backups (`agent.configure.backupDestination`) et plannings locaux. */
  backupDestination: z.string().optional(),
  backupSchedules: z.array(backupScheduleSchema).default([]),
  /** Dernière exécution par planning (évite les doublons, pas de rattrapage des occurrences manquées). */
  backupScheduleRuns: z.record(z.string(), z.int().nonnegative()).default({}),
  /** Phase 9 : dossiers sources renommés par `migration.finalize`, purgés après `purgeAfter`. */
  migratedDirs: z
    .array(z.object({ path: z.string(), purgeAfter: z.int().nonnegative() }))
    .default([]),
  seqs: z.record(z.string(), z.int().nonnegative()).default({}),
  pendingEvents: z.array(pendingEventSchema).default([]),
});
export type AgentState = z.infer<typeof agentStateSchema>;

export const STATE_FILE = 'agent-state.json';

export function emptyState(): AgentState {
  return agentStateSchema.parse({ version: 1 });
}

export interface StateStoreOptions {
  /** Applique les permissions restreintes au fichier (défaut : oui). */
  restrictPermissions?: boolean;
}

export class StateStore {
  readonly file: string;
  private state: AgentState = emptyState();
  private loaded = false;
  private writing: Promise<void> = Promise.resolve();
  private dirty = false;
  private readonly restrict: boolean;

  constructor(
    readonly dir: string,
    options: StateStoreOptions = {},
  ) {
    this.file = path.join(dir, STATE_FILE);
    this.restrict = options.restrictPermissions ?? true;
  }

  get(): AgentState {
    return this.state;
  }

  async load(): Promise<AgentState> {
    await mkdir(this.dir, { recursive: true });
    let text: string | undefined;
    try {
      text = await readFile(this.file, 'utf8');
    } catch {
      text = undefined;
    }
    this.state = emptyState();
    if (text !== undefined) {
      const parsed = agentStateSchema.safeParse(safeJsonParse(text));
      if (parsed.success) {
        this.state = parsed.data;
      } else {
        // Fichier illisible : mis de côté plutôt qu'écrasé silencieusement.
        await rename(this.file, `${this.file}.corrupt-${String(Date.now())}`).catch(
          () => undefined,
        );
      }
    }
    this.loaded = true;
    return this.state;
  }

  /** Modifie l'état puis planifie une écriture (coalescée avec les demandes concurrentes). */
  async update(mutate: (state: AgentState) => void): Promise<void> {
    mutate(this.state);
    await this.save();
  }

  /** Modification sans attendre l'écriture (compteurs `seq` : fsync périodique, doc 05 §7). */
  mutate(mutate: (state: AgentState) => void): void {
    mutate(this.state);
    this.dirty = true;
  }

  async flush(): Promise<void> {
    if (this.dirty) await this.save();
  }

  async save(): Promise<void> {
    if (!this.loaded) this.loaded = true;
    this.dirty = false;
    this.writing = this.writing.then(() => this.writeNow());
    await this.writing;
  }

  // --- Accesseurs pratiques ----------------------------------------------------------------

  getServer(serverId: string): ServerRecord | undefined {
    return this.state.servers[serverId];
  }

  serverConfigs(): ServerConfig[] {
    return Object.values(this.state.servers).map((r) => r.config);
  }

  nextSeq(channel: string): number {
    const next = (this.state.seqs[channel] ?? 0) + 1;
    this.state.seqs[channel] = next;
    this.dirty = true;
    return next;
  }

  currentSeq(channel: string): number {
    return this.state.seqs[channel] ?? 0;
  }

  private async writeNow(): Promise<void> {
    const snapshot = JSON.stringify(this.state, null, 2) + '\n';
    const tmp = `${this.file}.tmp`;
    try {
      await mkdir(this.dir, { recursive: true });
      await writeFile(tmp, snapshot, { mode: 0o600 });
      await renameWithRetry(tmp, this.file);
    } catch (error) {
      // Dossier d'état supprimé sous nos pieds (arrêt de l'agent, nettoyage de test) : rien à persister.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (this.restrict) await restrictFilePermissions(this.file);
  }
}

/** Windows : un antivirus/indexeur peut retenir brièvement le fichier cible (EPERM/EBUSY) — on insiste. */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code !== 'EPERM' && code !== 'EBUSY') || attempt >= 5) throw error;
      await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
    }
  }
}

/** chmod 600 (POSIX) ou ACL « propriétaire seul » via `icacls` (Windows, toujours présent). Best effort. */
export async function restrictFilePermissions(file: string): Promise<void> {
  if (process.platform !== 'win32') {
    await chmod(file, 0o600).catch(() => undefined);
    return;
  }
  const user = process.env.USERNAME;
  if (user === undefined || user === '') return;
  const domain = process.env.USERDOMAIN;
  const account = domain === undefined || domain === '' ? user : `${domain}\\${user}`;
  await new Promise<void>((resolve) => {
    const child = spawn(
      'icacls',
      [file, '/inheritance:r', '/grant:r', `${account}:F`, '/grant:r', '*S-1-5-18:F'],
      { stdio: 'ignore', windowsHide: true },
    );
    child.on('error', () => {
      resolve();
    });
    child.on('exit', () => {
      resolve();
    });
  });
}

/** Dossier d'état par défaut selon l'OS (surchargeable par `--state-dir` / `MMO_AGENT_STATE_DIR`). */
export function defaultStateDir(): string {
  const env = process.env.MMO_AGENT_STATE_DIR;
  if (env !== undefined && env !== '') return env;
  const home = process.env.HOME ?? process.env.USERPROFILE ?? process.cwd();
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'mmo-agent');
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'mmo-agent');
  }
  return path.join(process.env.XDG_DATA_HOME ?? path.join(home, '.local', 'share'), 'mmo-agent');
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
