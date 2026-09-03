/**
 * Page de statut publique (lot 8, doc 04 §1 et §8.6). Un lien `/s/<jeton>` que l'on donne à des
 * amis : nom du serveur, état, adresse à copier, version, MOTD, joueurs, prochaine sauvegarde.
 * Aucun compte, aucune action, aucun identifiant interne, aucun chemin disque.
 *
 * Trois décisions structurent ce fichier :
 *
 * 1. **Le jeton est en clair en base**, contrairement aux sessions et aux clés d'API. Il faut
 *    pouvoir le RÉAFFICHER (on partage un lien, on ne le retient pas) et il n'ouvre qu'une lecture
 *    anonyme. En contrepartie : 128 bits d'aléa, rotation d'un clic, et le limiteur public par
 *    adresse couvre l'énumération.
 * 2. **Les pseudos ne sortent qu'avec l'opt-in** `showPlayers` (doc 04 §8.6). Sans lui, la page
 *    publie un NOMBRE. C'est le réglage promis en lot 9, qui naît ici avec la page qui le lit.
 * 3. **Le résultat est mis en cache** (quelques secondes) et le ping Minecraft n'est tenté que si
 *    aucun agent ne tient la machine : dix amis qui rafraîchissent ne font ni dix requêtes à
 *    l'agent, ni dix pings. Les appels concurrents partagent la même promesse en vol.
 */
import { randomBytes } from 'node:crypto';

import { nextCronRun } from '@mmo/shared';
import {
  STATUS_PAGE_PREFIX,
  type PublicStatus,
  type ReachabilityResult,
  type StatusPageDto,
  type StatusPageInput,
} from '@mmo/protocol/client';
import type { DetectedServer } from '@mmo/protocol';
import { eq } from 'drizzle-orm';

import type { AgentRegistry } from '../agents/registry.js';
import type { MmoDatabase } from '../db/client.js';
import { serverStatusPages, type ServerRow, type ServerStatusPageRow } from '../db/schema.js';
import { pingMinecraft } from './access/mcping.js';
import type { AccessService } from './access.js';
import type { BackupsService } from './backups.js';
import type { ServersService } from './servers.js';
import { parseJson } from '../util/json.js';
import { SETTING_KEYS, type SettingsService } from './settings.js';

/** Durée de validité d'un état publié. Le ping de repli coûte une connexion TCP : jamais par vue. */
export const STATUS_CACHE_MS = 15_000;
/** Un serveur injoignable ne doit pas faire attendre le visiteur : le repli échoue vite. */
export const STATUS_PING_TIMEOUT_MS = 3_000;

export interface StatusPagesDeps {
  db: MmoDatabase;
  now: () => number;
  servers: ServersService;
  backups: BackupsService;
  registry: AgentRegistry;
  access: AccessService;
  settings: SettingsService;
  /** Injectable en test ; par défaut le Server List Ping du panel. */
  ping?: (address: string, timeoutMs: number) => Promise<ReachabilityResult>;
  cacheMs?: number;
  pingTimeoutMs?: number;
}

interface CacheEntry {
  at: number;
  value: PublicStatus;
}

export function generateStatusToken(): string {
  return randomBytes(16).toString('base64url');
}

export class StatusPagesService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<PublicStatus>>();

  constructor(private readonly deps: StatusPagesDeps) {}

  private get cacheMs(): number {
    return this.deps.cacheMs ?? STATUS_CACHE_MS;
  }

  // --- Réglage (opérateur du serveur) -----------------------------------------------------------

  row(serverId: string): ServerStatusPageRow | undefined {
    return this.deps.db
      .select()
      .from(serverStatusPages)
      .where(eq(serverStatusPages.serverId, serverId))
      .get();
  }

  /** Le réglage tel qu'il s'affiche, ou `undefined` si le serveur n'a jamais eu de page. */
  configOf(serverId: string): StatusPageDto | undefined {
    const row = this.row(serverId);
    return row === undefined ? undefined : this.toDto(row);
  }

  /**
   * Applique un réglage, en créant la ligne (et le jeton) au premier passage. Désactiver GARDE le
   * jeton : réactiver rend le même lien, celui qu'on a déjà donné à ses amis. Pour en changer,
   * c'est `rotate()`, un geste explicite.
   */
  set(serverId: string, input: StatusPageInput): StatusPageDto {
    const now = this.deps.now();
    const existing = this.row(serverId);
    if (existing === undefined) {
      const created: ServerStatusPageRow = {
        serverId,
        token: generateStatusToken(),
        enabled: input.enabled === true ? 1 : 0,
        showPlayers: input.showPlayers === true ? 1 : 0,
        createdAt: now,
        updatedAt: now,
      };
      this.deps.db.insert(serverStatusPages).values(created).run();
      return this.toDto(created);
    }
    const next: ServerStatusPageRow = {
      ...existing,
      enabled: input.enabled === undefined ? existing.enabled : input.enabled ? 1 : 0,
      showPlayers:
        input.showPlayers === undefined ? existing.showPlayers : input.showPlayers ? 1 : 0,
      updatedAt: now,
    };
    this.deps.db
      .update(serverStatusPages)
      .set({ enabled: next.enabled, showPlayers: next.showPlayers, updatedAt: next.updatedAt })
      .where(eq(serverStatusPages.serverId, serverId))
      .run();
    // Le contenu publié change (pseudos publiés ou non) : l'état en cache ne vaut plus.
    this.cache.delete(serverId);
    return this.toDto(next);
  }

  /** Nouveau lien : l'ancien cesse immédiatement de répondre. */
  rotate(serverId: string): StatusPageDto {
    const existing = this.row(serverId);
    if (existing === undefined) return this.set(serverId, {});
    const next: ServerStatusPageRow = {
      ...existing,
      token: generateStatusToken(),
      updatedAt: this.deps.now(),
    };
    this.deps.db
      .update(serverStatusPages)
      .set({ token: next.token, updatedAt: next.updatedAt })
      .where(eq(serverStatusPages.serverId, serverId))
      .run();
    return this.toDto(next);
  }

  toDto(row: ServerStatusPageRow): StatusPageDto {
    const path = STATUS_PAGE_PREFIX + row.token;
    const base = this.deps.settings.get(SETTING_KEYS.publicUrl);
    return {
      serverId: row.serverId,
      enabled: row.enabled === 1,
      showPlayers: row.showPlayers === 1,
      token: row.token,
      path,
      url: base === undefined || base === '' ? null : base.replace(/\/+$/, '') + path,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  // --- Surface publique --------------------------------------------------------------------------

  /**
   * Le serveur derrière un jeton, ou `undefined` : jeton inconnu, page désactivée, serveur
   * disparu ou archivé. Un seul et même `undefined` pour tous ces cas — le visiteur n'apprend
   * jamais si le lien a existé.
   */
  resolve(token: string): ServerRow | undefined {
    if (token === '') return undefined;
    const row = this.deps.db
      .select()
      .from(serverStatusPages)
      .where(eq(serverStatusPages.token, token))
      .get();
    if (row?.enabled !== 1) return undefined;
    const server = this.deps.servers.get(row.serverId);
    if (server === undefined || server.provisioning === 'archived') return undefined;
    return server;
  }

  /** L'état publié pour ce jeton (cache court), ou `undefined` si le lien ne mène à rien. */
  async status(token: string): Promise<PublicStatus | undefined> {
    const server = this.resolve(token);
    if (server === undefined) return undefined;
    const cached = this.cache.get(server.id);
    if (cached !== undefined && this.deps.now() - cached.at < this.cacheMs) return cached.value;
    const pending = this.inflight.get(server.id);
    if (pending !== undefined) return pending;
    const promise = this.build(server).finally(() => this.inflight.delete(server.id));
    this.inflight.set(server.id, promise);
    return promise;
  }

  private async build(server: ServerRow): Promise<PublicStatus> {
    const row = this.row(server.id);
    const address = this.deps.access.serverAddress(server).address;
    // L'agent est la source de vérité quand il est là : l'état, les joueurs et le MOTD sont déjà
    // en base (événements `server.stateChanged` et `player.event`), aucun aller-retour nécessaire.
    const online = this.deps.registry.get(server.machineId) !== undefined;
    const value: PublicStatus = online
      ? this.fromPanel(server, row, address)
      : await this.fromPing(server, row, address);
    this.cache.set(server.id, { at: this.deps.now(), value });
    return value;
  }

  private fromPanel(
    server: ServerRow,
    row: ServerStatusPageRow | undefined,
    address: string | null,
  ): PublicStatus {
    const named = row?.showPlayers === 1;
    const running = server.runState === 'running';
    const players = running ? this.deps.servers.onlinePlayers(server.id) : [];
    return {
      name: server.name,
      state: publicState(server.runState),
      address,
      version: server.mcVersion,
      loader: server.loader,
      motd: motdOf(server),
      players: {
        online: running ? players.length : 0,
        max: null,
        names: named ? players.map((p) => p.name) : [],
        named,
      },
      nextBackupAt: this.nextBackupAt(server.id),
      source: 'agent',
      updatedAt: this.deps.now(),
    };
  }

  /**
   * Repli quand aucun agent ne tient la machine : le serveur, lui, tourne peut-être toujours (les
   * serveurs Java survivent à l'agent). Un Server List Ping donne l'état réel, la version, le MOTD
   * et le nombre de joueurs — jamais leurs pseudos, que le protocole n'expose pas de façon fiable.
   */
  private async fromPing(
    server: ServerRow,
    row: ServerStatusPageRow | undefined,
    address: string | null,
  ): Promise<PublicStatus> {
    const named = row?.showPlayers === 1;
    const base: PublicStatus = {
      name: server.name,
      state: 'unknown',
      address,
      version: server.mcVersion,
      loader: server.loader,
      motd: motdOf(server),
      players: { online: null, max: null, names: [], named },
      nextBackupAt: this.nextBackupAt(server.id),
      source: 'none',
      updatedAt: this.deps.now(),
    };
    if (address === null) return base;
    const ping = this.deps.ping ?? ((a, timeoutMs) => pingMinecraft(a, { timeoutMs }));
    let result: ReachabilityResult;
    try {
      result = await ping(address, this.deps.pingTimeoutMs ?? STATUS_PING_TIMEOUT_MS);
    } catch {
      return { ...base, state: 'offline', source: 'ping', updatedAt: this.deps.now() };
    }
    if (!result.ok) {
      return { ...base, state: 'offline', source: 'ping', updatedAt: this.deps.now() };
    }
    return {
      ...base,
      state: 'online',
      version: result.status?.version ?? base.version,
      motd: result.status?.motd ?? base.motd,
      players: {
        online: result.status?.online ?? null,
        max: result.status?.max ?? null,
        names: [],
        named,
      },
      source: 'ping',
      updatedAt: this.deps.now(),
    };
  }

  /** Prochaine occurrence, toutes politiques actives confondues (jamais la destination). */
  private nextBackupAt(serverId: string): number | null {
    const zone = this.deps.settings.timeZone();
    const from = this.deps.now();
    let best: number | undefined;
    for (const policy of this.deps.backups.listPolicies(serverId)) {
      if (policy.enabled !== 1) continue;
      const next = nextCronRun(policy.cron, from, zone);
      if (next !== undefined && (best === undefined || next < best)) best = next;
    }
    return best ?? null;
  }
}

/** `crashed` n'est pas le sujet d'un ami venu jouer : le serveur est en ligne, ou il ne l'est pas. */
function publicState(runState: ServerRow['runState']): PublicStatus['state'] {
  switch (runState) {
    case 'running':
      return 'online';
    case 'starting':
      return 'starting';
    case 'stopping':
      return 'stopping';
    case 'stopped':
    case 'crashed':
      return 'offline';
  }
}

/** MOTD lu à la détection (`server.properties` ou `velocity.toml`), jamais un chemin ni un id. */
function motdOf(server: ServerRow): string | null {
  const detection = parseJson<DetectedServer | undefined>(server.detectionJson, undefined);
  const motd = detection?.motd;
  return motd === undefined || motd === '' ? null : motd;
}
