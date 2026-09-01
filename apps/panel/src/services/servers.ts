/**
 * Serveurs Minecraft (doc 04 §3–§4) : adoption des détections (le panel attribue les IDs, conflit
 * explicite si un marqueur connu réapparaît ailleurs), réconciliation sur `sync.state` (l'agent
 * est la vérité terrain), états poussés par `server.stateChanged`, joueurs (`player_sessions`
 * clôturées sur stop/crash et à chaque réconciliation), configuration poussée via `agent.configure`.
 */
import {
  ulid,
  type DetectedServer,
  type ParsedEventPayload,
  type ParsedRequestPayload,
  type RequestPayload,
  type ServerConfig,
} from '@mmo/protocol';
import type { ServerConflictDto, ServerDto } from '@mmo/protocol/client';
import { and, asc, desc, eq, isNotNull, isNull, lt, ne } from 'drizzle-orm';

import type { MmoDatabase } from '../db/client.js';
import {
  players,
  playerSessions,
  serverGroups,
  servers,
  watchedDirectories,
  type ServerRow,
} from '../db/schema.js';
import { conflict, notFound } from '../errors.js';
import { parseJson, toJson } from '../util/json.js';
import type { EventBus } from './events.js';
import type { JavaResolver } from './java.js';
import { SETTING_KEYS, type SettingsService } from './settings.js';

type SyncState = ParsedRequestPayload<'sync.state'>;
type StateChanged = ParsedEventPayload<'server.stateChanged'>;
type PlayerEvent = ParsedEventPayload<'player.event'>;

export interface AdoptResult {
  server: ServerRow | undefined;
  created: boolean;
  conflict: ServerConflictDto | undefined;
}

export interface UpdateServerInput {
  name?: string | undefined;
  minRamMb?: number | undefined;
  maxRamMb?: number | undefined;
  javaMajorRequired?: number | null | undefined;
  javaArgs?: string[] | undefined;
  gamePort?: number | null | undefined;
  exposeMode?: 'tailnet' | 'direct' | undefined;
  autoRestart?: boolean | undefined;
  crashLoopMax?: number | undefined;
  watchdogFreezeS?: number | undefined;
  provisioning?: 'ready' | 'archived' | undefined;
  groupId?: string | null | undefined;
  groupPosition?: number | undefined;
}

export interface ServersServiceDeps {
  db: MmoDatabase;
  now: () => number;
  events: EventBus;
  java: JavaResolver;
  settings: SettingsService;
  /** Phase 8 : plannings de backups poussés à l'agent (`backup_policies`). */
  backupSchedules?: (serverIds: string[]) => RequestPayload<'agent.configure'>['backupSchedules'];
  /** Recette 1.0 : politique de sauvegarde par défaut posée à la création d'un serveur. */
  seedBackupPolicy?: (serverId: string) => void;
}

const RUNNING_STATES: ReadonlySet<ServerRow['runState']> = new Set([
  'starting',
  'running',
  'stopping',
]);

export class ServersService {
  private readonly conflicts = new Map<string, ServerConflictDto>();
  private readonly db: MmoDatabase;
  private readonly now: () => number;

  constructor(private readonly deps: ServersServiceDeps) {
    this.db = deps.db;
    this.now = deps.now;
  }

  // --- Lecture --------------------------------------------------------------------------------

  list(): ServerRow[] {
    return this.db.select().from(servers).orderBy(asc(servers.name)).all();
  }

  /** Membres d'un groupe, dans l'ordre de démarrage (rang croissant, nom en départage). */
  listByGroup(groupId: string): ServerRow[] {
    return this.db
      .select()
      .from(servers)
      .where(eq(servers.groupId, groupId))
      .orderBy(asc(servers.groupPosition), asc(servers.name))
      .all();
  }

  listByMachine(machineId: string): ServerRow[] {
    return this.db
      .select()
      .from(servers)
      .where(eq(servers.machineId, machineId))
      .orderBy(asc(servers.name))
      .all();
  }

  get(id: string): ServerRow | undefined {
    return this.db.select().from(servers).where(eq(servers.id, id)).get();
  }

  require(id: string): ServerRow {
    const row = this.get(id);
    if (!row) throw notFound('server', id);
    return row;
  }

  findByPath(machineId: string, serverPath: string): ServerRow | undefined {
    return this.db
      .select()
      .from(servers)
      .where(and(eq(servers.machineId, machineId), eq(servers.path, serverPath)))
      .get();
  }

  toDto(row: ServerRow, reachable: boolean): ServerDto {
    const detection = parseJson<DetectedServer | undefined>(row.detectionJson, undefined);
    return {
      id: row.id,
      machineId: row.machineId,
      directoryId: row.directoryId,
      path: row.path,
      name: row.name,
      loader: row.loader,
      mcVersion: row.mcVersion,
      loaderVersion: row.loaderVersion,
      detected: row.detected === 1,
      javaMajorRequired: row.javaMajorRequired,
      javaArgs: parseJson<string[]>(row.javaArgs, []),
      minRamMb: row.minRamMb,
      maxRamMb: row.maxRamMb,
      gamePort: row.gamePort,
      rconEnabled: row.rconEnabled === 1,
      rconPort: row.rconPort,
      eulaAccepted: row.eulaAccepted === 1,
      exposeMode: row.exposeMode,
      provisioning: row.provisioning,
      runState: row.runState,
      desiredState: row.desiredState,
      attachMode: row.attachMode,
      lastExitReason: asExitReason(row.lastExitReason),
      autoRestart: row.autoRestart === 1,
      crashLoopMax: row.crashLoopMax,
      watchdogFreezeS: row.watchdogFreezeS,
      pid: row.pid,
      startedAt: row.startedAt,
      stoppedAt: row.stoppedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      reachable,
      groupId: row.groupId,
      groupPosition: row.groupPosition,
      ...(detection === undefined ? {} : { detection }),
    };
  }

  // --- Adoption (autorité des IDs, doc 04 §3) ---------------------------------------------------

  /**
   * Traite une détection : mise à jour d'un serveur connu (même machine + chemin), conflit si le
   * marqueur porte un ID connu ailleurs, sinon adoption (ID du marqueur s'il est inconnu du panel —
   * base restaurée —, sinon nouvel ULID).
   */
  async adoptDetected(
    machineId: string,
    detected: DetectedServer,
    directoryId: string | undefined,
  ): Promise<AdoptResult> {
    const key = conflictKey(machineId, detected.path);
    directoryId = this.resolveDirectoryId(machineId, detected.path, directoryId);
    const byPath = this.findByPath(machineId, detected.path);
    if (byPath) {
      this.conflicts.delete(key);
      const row = await this.updateDetection(byPath, detected, directoryId);
      if (detected.markerServerId !== undefined && detected.markerServerId !== row.id) {
        this.deps.events.publish({
          type: 'server.markerMismatch',
          severity: 'warning',
          machineId,
          serverId: row.id,
          payload: { path: detected.path, markerServerId: detected.markerServerId },
        });
      }
      return { server: row, created: false, conflict: undefined };
    }
    let id: string;
    if (detected.markerServerId !== undefined) {
      const known = this.get(detected.markerServerId);
      if (known) {
        const dto: ServerConflictDto = {
          key,
          serverId: known.id,
          known: { machineId: known.machineId, path: known.path },
          found: { machineId, path: detected.path },
          detectedAt: this.now(),
          detection: detected,
        };
        const isNew = !this.conflicts.has(key);
        this.conflicts.set(key, dto);
        if (isNew) {
          this.deps.events.publish({
            type: 'server.conflict',
            severity: 'warning',
            machineId,
            serverId: known.id,
            payload: { key, known: dto.known, found: dto.found },
          });
        }
        return { server: undefined, created: false, conflict: dto };
      }
      id = detected.markerServerId;
    } else {
      id = ulid(this.now());
    }
    let row: ServerRow;
    try {
      row = await this.insertFromDetection(id, machineId, detected, directoryId);
    } catch (error) {
      // Course entre deux adoptions du même chemin (scan périodique du répertoire fraîchement
      // surveillé vs ajout manuel) : le `findByPath` d'entrée précède l'`await java.resolve`
      // d'`insertFromDetection`, les deux appels peuvent donc le passer avant le premier INSERT.
      // L'index UNIQUE (machine_id, path) fait autorité — on retombe sur le serveur déjà adopté
      // au lieu de laisser fuir une erreur SQLite brute (E_INTERNAL vu en utilisation réelle).
      const existing = isUniquePathViolation(error)
        ? this.findByPath(machineId, detected.path)
        : undefined;
      if (existing === undefined) throw error;
      this.conflicts.delete(key);
      const updated = await this.updateDetection(existing, detected, directoryId);
      return { server: updated, created: false, conflict: undefined };
    }
    this.deps.events.publish({
      type: 'server.adopted',
      machineId,
      serverId: row.id,
      payload: { path: row.path, name: row.name, loader: row.loader, mcVersion: row.mcVersion },
    });
    return { server: row, created: true, conflict: undefined };
  }

  listConflicts(): ServerConflictDto[] {
    return [...this.conflicts.values()];
  }

  /** Résolution d'un conflit : `copy` = nouvel ID à cet emplacement ; `migrate` = l'ID suit le dossier. */
  async resolveConflict(
    key: string,
    resolution: 'copy' | 'migrate' | 'ignore',
  ): Promise<ServerRow | undefined> {
    const c = this.conflicts.get(key);
    if (!c) throw notFound('conflict', key);
    this.conflicts.delete(key);
    switch (resolution) {
      case 'ignore':
        return undefined;
      case 'copy': {
        const row = await this.insertFromDetection(
          ulid(this.now()),
          c.found.machineId,
          c.detection,
          this.directoryIdFor(c.found.machineId, c.found.path),
        );
        this.deps.events.publish({
          type: 'server.adopted',
          machineId: row.machineId,
          serverId: row.id,
          payload: { path: row.path, name: row.name, copiedFrom: c.serverId },
        });
        return row;
      }
      case 'migrate': {
        const existing = this.require(c.serverId);
        if (RUNNING_STATES.has(existing.runState)) {
          throw conflict('server is running at its known location', { serverId: existing.id });
        }
        const directoryId = this.directoryIdFor(c.found.machineId, c.found.path) ?? null;
        this.db
          .update(servers)
          .set({
            machineId: c.found.machineId,
            path: c.found.path,
            directoryId,
            updatedAt: this.now(),
          })
          .where(eq(servers.id, existing.id))
          .run();
        const row = await this.updateDetection(
          this.require(existing.id),
          c.detection,
          directoryId ?? undefined,
        );
        this.deps.events.publish({
          type: 'server.migrated',
          machineId: row.machineId,
          serverId: row.id,
          payload: { from: c.known, to: c.found },
        });
        return row;
      }
    }
  }

  /** ID de répertoire annoncé par l'agent s'il est connu, sinon déduit du chemin (jamais une FK invalide). */
  private resolveDirectoryId(
    machineId: string,
    serverPath: string,
    announced: string | undefined,
  ): string | undefined {
    if (announced !== undefined) {
      const known = this.db
        .select()
        .from(watchedDirectories)
        .where(
          and(eq(watchedDirectories.id, announced), eq(watchedDirectories.machineId, machineId)),
        )
        .get();
      if (known) return known.id;
    }
    return this.directoryIdFor(machineId, serverPath);
  }

  private directoryIdFor(machineId: string, serverPath: string): string | undefined {
    const norm = normalizePath(serverPath);
    const dirs = this.db
      .select()
      .from(watchedDirectories)
      .where(eq(watchedDirectories.machineId, machineId))
      .all();
    return dirs.find((d) => norm.startsWith(normalizePath(d.path) + '/'))?.id;
  }

  private async insertFromDetection(
    id: string,
    machineId: string,
    d: DetectedServer,
    directoryId: string | undefined,
  ): Promise<ServerRow> {
    const t = this.now();
    const java = await this.deps.java.resolve({
      mcVersion: d.mcVersion?.value,
      loader: d.loader.value,
      override: undefined,
    });
    const row: ServerRow = {
      id,
      machineId,
      directoryId: directoryId ?? null,
      path: d.path,
      name: d.name,
      loader: d.loader.value,
      mcVersion: d.mcVersion?.value ?? null,
      loaderVersion: d.loaderVersion?.value ?? null,
      detected: 1,
      javaRuntimeId: null,
      javaMajorRequired: java?.majorVersion ?? d.javaRequirement?.majorVersion ?? null,
      javaArgs: null,
      minRamMb: d.minRamMb?.value ?? Math.min(1024, d.maxRamMb.value),
      maxRamMb: d.maxRamMb.value,
      gamePort: d.gamePort ?? null,
      // Un proxy Velocity n'a pas de RCON (et le provisionner créerait un server.properties).
      rconEnabled: d.loader.value === 'velocity' ? 0 : 1,
      rconPort: d.rconPort ?? null,
      rconPasswordEnc: null,
      eulaAccepted: d.eulaAccepted ? 1 : 0,
      exposeMode: 'tailnet',
      provisioning: d.needsInstall === true ? 'installing' : 'ready',
      runState: 'stopped',
      desiredState: 'stopped',
      attachMode: 'attached',
      lastExitReason: null,
      autoRestart: 0,
      crashLoopMax: 3,
      watchdogFreezeS: 120,
      pid: null,
      startedAt: null,
      stoppedAt: null,
      detectionJson: toJson(d),
      createdAt: t,
      updatedAt: t,
      groupId: null,
      groupPosition: 0,
    };
    this.db.insert(servers).values(row).run();
    // Sauvegarde « prête à l'emploi » : chaque nouveau serveur reçoit la politique par défaut
    // (quotidienne, rétention 7, si en marche). Jamais bloquant pour l'adoption.
    try {
      this.deps.seedBackupPolicy?.(row.id);
    } catch {
      // la politique pourra être créée à la main
    }
    return row;
  }

  /** Rafraîchit les métadonnées détectées d'un serveur connu (sans écraser les réglages utilisateur). */
  private async updateDetection(
    row: ServerRow,
    d: DetectedServer,
    directoryId: string | undefined,
  ): Promise<ServerRow> {
    const previous = parseJson<DetectedServer | undefined>(row.detectionJson, undefined);
    const userOverrodeJava =
      row.javaMajorRequired !== null &&
      previous !== undefined &&
      row.javaMajorRequired !== (previous.javaRequirement?.majorVersion ?? null);
    const java = userOverrodeJava
      ? undefined
      : await this.deps.java.resolve({
          mcVersion: d.mcVersion?.value,
          loader: d.loader.value,
          override: undefined,
        });
    const patch: Partial<ServerRow> = {
      loader: d.loader.value,
      mcVersion: d.mcVersion?.value ?? row.mcVersion,
      loaderVersion: d.loaderVersion?.value ?? row.loaderVersion,
      detected: 1,
      eulaAccepted: d.eulaAccepted ? 1 : 0,
      gamePort: d.gamePort ?? row.gamePort,
      rconPort: d.rconPort ?? row.rconPort,
      detectionJson: toJson(d),
      updatedAt: this.now(),
      ...(directoryId === undefined ? {} : { directoryId }),
      ...(java === undefined ? {} : { javaMajorRequired: java.majorVersion }),
    };
    if (row.provisioning === 'installing' && d.needsInstall !== true) patch.provisioning = 'ready';
    this.db.update(servers).set(patch).where(eq(servers.id, row.id)).run();
    return this.require(row.id);
  }

  /** `server.removed` : le dossier a disparu (le serveur reste connu, marqué non détecté). */
  markRemoved(
    machineId: string,
    serverPath: string,
    serverId: string | undefined,
  ): ServerRow | undefined {
    const row =
      serverId === undefined ? this.findByPath(machineId, serverPath) : this.get(serverId);
    if (!row) return undefined;
    this.db
      .update(servers)
      .set({ detected: 0, updatedAt: this.now() })
      .where(eq(servers.id, row.id))
      .run();
    this.deps.events.publish({
      type: 'server.removed',
      severity: 'warning',
      machineId,
      serverId: row.id,
      payload: { path: serverPath },
    });
    return this.require(row.id);
  }

  // --- Réglages ----------------------------------------------------------------------------------

  async update(id: string, input: UpdateServerInput): Promise<ServerRow> {
    const row = this.require(id);
    const patch: Partial<ServerRow> = { updatedAt: this.now() };
    if (input.name !== undefined) patch.name = input.name;
    if (input.minRamMb !== undefined) patch.minRamMb = input.minRamMb;
    if (input.maxRamMb !== undefined) patch.maxRamMb = input.maxRamMb;
    if ((patch.minRamMb ?? row.minRamMb) > (patch.maxRamMb ?? row.maxRamMb)) {
      throw conflict('minRamMb must be ≤ maxRamMb');
    }
    if (input.javaArgs !== undefined) patch.javaArgs = toJson(input.javaArgs);
    if (input.gamePort !== undefined) patch.gamePort = input.gamePort;
    if (input.exposeMode !== undefined) patch.exposeMode = input.exposeMode;
    if (input.autoRestart !== undefined) patch.autoRestart = input.autoRestart ? 1 : 0;
    if (input.crashLoopMax !== undefined) patch.crashLoopMax = input.crashLoopMax;
    if (input.watchdogFreezeS !== undefined) patch.watchdogFreezeS = input.watchdogFreezeS;
    if (input.provisioning !== undefined) {
      if (input.provisioning === 'archived' && RUNNING_STATES.has(row.runState)) {
        throw conflict('cannot archive a running server', { serverId: id });
      }
      patch.provisioning = input.provisioning;
    }
    if (input.groupId !== undefined) {
      if (input.groupId !== null) {
        const group = this.db
          .select()
          .from(serverGroups)
          .where(eq(serverGroups.id, input.groupId))
          .get();
        if (!group) throw notFound('group', input.groupId);
      }
      patch.groupId = input.groupId;
      // Nouveau membre sans rang explicite : en fin de groupe. Retiré du groupe : rang remis à 0.
      if (input.groupId === null) patch.groupPosition = 0;
      else if (input.groupPosition === undefined && input.groupId !== row.groupId) {
        const max = this.listByGroup(input.groupId).reduce(
          (m, r) => Math.max(m, r.groupPosition),
          -1,
        );
        patch.groupPosition = max + 1;
      }
    }
    if (input.groupPosition !== undefined && input.groupId !== null) {
      patch.groupPosition = input.groupPosition;
    }
    if (input.javaMajorRequired !== undefined) {
      if (input.javaMajorRequired === null) {
        const d = parseJson<DetectedServer | undefined>(row.detectionJson, undefined);
        const java = await this.deps.java.resolve({
          mcVersion: row.mcVersion ?? undefined,
          loader: row.loader,
          override: undefined,
        });
        patch.javaMajorRequired = java?.majorVersion ?? d?.javaRequirement?.majorVersion ?? null;
      } else patch.javaMajorRequired = input.javaMajorRequired;
    }
    this.db.update(servers).set(patch).where(eq(servers.id, id)).run();
    return this.require(id);
  }

  setDesiredState(id: string, desired: 'running' | 'stopped'): ServerRow {
    this.db
      .update(servers)
      .set({ desiredState: desired, updatedAt: this.now() })
      .where(eq(servers.id, id))
      .run();
    return this.require(id);
  }

  delete(id: string): void {
    const row = this.require(id);
    if (RUNNING_STATES.has(row.runState)) {
      throw conflict('cannot delete a running server', { serverId: id });
    }
    this.db.delete(servers).where(eq(servers.id, id)).run();
  }

  // --- Phase 9 : migration ---------------------------------------------------------------------

  setProvisioning(id: string, provisioning: ServerRow['provisioning']): void {
    this.db
      .update(servers)
      .set({ provisioning, updatedAt: this.now() })
      .where(eq(servers.id, id))
      .run();
  }

  /**
   * Bascule de propriété après import réussi : le serveur appartient à la machine cible, au nouveau
   * chemin (même `id`, marqueur réécrit par l'agent cible). Les sessions joueurs ouvertes sont closes.
   */
  moveToMachine(
    id: string,
    target: {
      machineId: string;
      path: string;
      directoryId: string | null;
      desiredState: 'running' | 'stopped';
      running: boolean;
    },
  ): ServerRow {
    const t = this.now();
    this.closePlayerSessions(id, t);
    // Une ligne périmée (dossier disparu, `detected = 0`) au même chemin sur la cible céderait la place.
    const stale = this.findByPath(target.machineId, target.path);
    if (stale && stale.id !== id) {
      if (stale.detected === 1 || RUNNING_STATES.has(stale.runState)) {
        throw conflict('another server is registered at the target path', { serverId: stale.id });
      }
      this.db.delete(servers).where(eq(servers.id, stale.id)).run();
    }
    this.db
      .update(servers)
      .set({
        machineId: target.machineId,
        path: target.path,
        directoryId: target.directoryId,
        provisioning: 'ready',
        desiredState: target.desiredState,
        runState: target.running ? 'starting' : 'stopped',
        attachMode: 'attached',
        pid: null,
        startedAt: null,
        stoppedAt: t,
        detected: 1,
        updatedAt: t,
      })
      .where(eq(servers.id, id))
      .run();
    return this.require(id);
  }

  /**
   * Duplication : crée la ligne du clone AVANT l'import — l'UI le voit tout de suite, et un scan
   * qui découvrirait le dossier en cours d'extraction retombe sur cette ligne (`findByPath`) au
   * lieu d'adopter un doublon. Réglages copiés de la source ; le RCON n'est pas copié (l'agent en
   * réattribue un au premier démarrage), le runtime Java est re-résolu sur la cible.
   */
  insertDuplicate(
    source: ServerRow,
    target: {
      id: string;
      machineId: string;
      directoryId: string | null;
      path: string;
      name: string;
      gamePort: number;
    },
  ): ServerRow {
    const t = this.now();
    const row: ServerRow = {
      ...source,
      id: target.id,
      machineId: target.machineId,
      directoryId: target.directoryId,
      path: target.path,
      name: target.name,
      gamePort: target.gamePort,
      detected: 0,
      javaRuntimeId: null,
      rconPort: null,
      rconPasswordEnc: null,
      // Le clone ne rejoint pas le groupe de la source (les rangs y entreraient en collision).
      groupId: null,
      groupPosition: 0,
      provisioning: 'migrating',
      runState: 'stopped',
      desiredState: 'stopped',
      attachMode: 'attached',
      lastExitReason: null,
      pid: null,
      startedAt: null,
      stoppedAt: null,
      createdAt: t,
      updatedAt: t,
    };
    this.db.insert(servers).values(row).run();
    try {
      this.deps.seedBackupPolicy?.(row.id);
    } catch {
      // la politique pourra être créée à la main
    }
    return row;
  }

  /** Fin de duplication : le clone est en place sur la cible, prêt et arrêté. */
  confirmDuplicated(id: string, gamePort: number | null): ServerRow {
    const t = this.now();
    this.db
      .update(servers)
      .set({ provisioning: 'ready', detected: 1, gamePort, stoppedAt: t, updatedAt: t })
      .where(eq(servers.id, id))
      .run();
    return this.require(id);
  }

  // --- Configuration poussée à l'agent -----------------------------------------------------------

  /** `agent.configure` complet pour une machine (liste complète : un serveur absent est oublié par l'agent). */
  buildAgentConfig(machineId: string): RequestPayload<'agent.configure'> {
    const rows = this.listByMachine(machineId).filter((r) => r.provisioning !== 'archived');
    const dirs = this.db
      .select()
      .from(watchedDirectories)
      .where(eq(watchedDirectories.machineId, machineId))
      .all();
    const desiredStates: Record<string, 'running' | 'stopped'> = {};
    for (const r of rows) desiredStates[r.id] = r.desiredState;
    return {
      watchedDirectories: dirs.map((d) => ({ id: d.id, path: d.path, enabled: d.enabled === 1 })),
      servers: rows.map((r) => this.toAgentConfig(r)),
      watchdog: rows.map((r) => ({
        serverId: r.id,
        autoRestart: r.autoRestart === 1,
        crashLoopMax: r.crashLoopMax,
        freezeTimeoutSec: r.watchdogFreezeS,
        freezeAction: 'kill_restart' as const,
      })),
      desiredStates,
      restoreOnBoot: this.deps.settings.getBool(SETTING_KEYS.restoreOnBoot),
      metricsIntervalSec: this.deps.settings.getInt(SETTING_KEYS.metricsIntervalSec, 15),
      // Phase 8 : destination globale (chaîne vide = défaut agent) et plannings de backups autonomes.
      backupDestination: this.deps.settings.get(SETTING_KEYS.backupDestination) ?? '',
      backupSchedules: this.deps.backupSchedules?.(rows.map((r) => r.id)) ?? [],
    };
  }

  toAgentConfig(r: ServerRow): ServerConfig {
    const d = parseJson<DetectedServer | undefined>(r.detectionJson, undefined);
    const javaArgs = parseJson<string[]>(r.javaArgs, []);
    return {
      serverId: r.id,
      path: r.path,
      name: r.name,
      maxRamMb: r.maxRamMb,
      minRamMb: r.minRamMb,
      loader: r.loader,
      ...(r.mcVersion === null ? {} : { mcVersion: r.mcVersion }),
      ...(d?.launch === undefined ? {} : { launch: d.launch }),
      ...(r.javaMajorRequired === null ? {} : { javaMajor: r.javaMajorRequired }),
      ...(d?.javaRequirement?.strict === true ? { javaStrict: true } : {}),
      ...(javaArgs.length === 0 ? {} : { jvmArgs: javaArgs }),
    };
  }

  // --- Réconciliation (doc 04 §8.5) ------------------------------------------------------------

  /**
   * Compare le snapshot de l'agent à la base : états corrigés (événements « manquants » émis),
   * sessions joueurs orphelines clôturées, serveurs connus de la base mais inconnus de l'agent
   * remis à `stopped`. Retourne les serveurs à relancer (`desired_state='running'`).
   */
  applySyncState(
    machineId: string,
    snapshot: SyncState,
  ): { toStart: ServerRow[]; unknown: string[] } {
    const t = this.now();
    const seen = new Set<string>();
    const unknown: string[] = [];
    for (const s of snapshot.servers) {
      const row =
        (s.serverId === undefined ? undefined : this.get(s.serverId)) ??
        this.findByPath(machineId, s.path);
      if (row?.machineId !== machineId) {
        unknown.push(s.serverId ?? s.path);
        continue;
      }
      seen.add(row.id);
      const running = RUNNING_STATES.has(s.runState);
      const patch: Partial<ServerRow> = {
        runState: s.runState,
        attachMode: s.attachMode,
        pid: running ? (s.pid ?? null) : null,
        updatedAt: t,
        ...(s.gamePort === undefined ? {} : { gamePort: s.gamePort }),
        ...(s.rconPort === undefined ? {} : { rconPort: s.rconPort }),
      };
      if (running) patch.startedAt = s.startedAt ?? row.startedAt ?? t;
      else if (RUNNING_STATES.has(row.runState)) patch.stoppedAt = t;
      this.db.update(servers).set(patch).where(eq(servers.id, row.id)).run();
      if (row.runState !== s.runState) {
        this.deps.events.publish({
          type: 'server.stateChanged',
          severity: s.runState === 'crashed' ? 'error' : 'info',
          machineId,
          serverId: row.id,
          payload: { state: s.runState, previous: row.runState, reconciled: true },
        });
      }
      if (!running) this.closePlayerSessions(row.id, t);
    }
    for (const row of this.listByMachine(machineId)) {
      if (seen.has(row.id) || !RUNNING_STATES.has(row.runState)) continue;
      this.db
        .update(servers)
        .set({ runState: 'stopped', pid: null, stoppedAt: t, updatedAt: t })
        .where(eq(servers.id, row.id))
        .run();
      this.closePlayerSessions(row.id, t);
      this.deps.events.publish({
        type: 'server.stateChanged',
        severity: 'warning',
        machineId,
        serverId: row.id,
        payload: {
          state: 'stopped',
          previous: row.runState,
          reconciled: true,
          unknownToAgent: true,
        },
      });
    }
    const toStart = this.listByMachine(machineId).filter(
      (r) =>
        r.desiredState === 'running' &&
        !RUNNING_STATES.has(r.runState) &&
        r.provisioning === 'ready',
    );
    return { toStart, unknown };
  }

  /** `server.stateChanged` (toujours émis par l'agent ; le panel ne déduit jamais un état). */
  applyStateChanged(p: StateChanged, machineId: string): ServerRow | undefined {
    const row = this.get(p.serverId);
    if (row?.machineId !== machineId) return undefined;
    const running = RUNNING_STATES.has(p.state);
    const patch: Partial<ServerRow> = {
      runState: p.state,
      updatedAt: this.now(),
      ...(p.attachMode === undefined ? {} : { attachMode: p.attachMode }),
    };
    if (p.state === 'starting') {
      patch.startedAt = p.ts;
      patch.pid = p.pid ?? null;
      patch.lastExitReason = null;
    } else if (p.state === 'running') {
      patch.pid = p.pid ?? row.pid;
      if (row.startedAt === null) patch.startedAt = p.ts;
    } else if (!running) {
      patch.pid = null;
      patch.stoppedAt = p.ts;
      patch.lastExitReason = p.exitReason ?? (p.state === 'crashed' ? 'crash' : null);
    }
    this.db.update(servers).set(patch).where(eq(servers.id, p.serverId)).run();
    if (!running) this.closePlayerSessions(p.serverId, p.ts);
    this.deps.events.publish({
      type: 'server.stateChanged',
      severity: p.state === 'crashed' ? 'error' : 'info',
      machineId,
      serverId: p.serverId,
      payload: p,
      ts: p.ts,
    });
    return this.require(p.serverId);
  }

  // --- Joueurs (doc 04 §4) --------------------------------------------------------------------

  applyPlayerEvent(p: PlayerEvent, machineId: string): void {
    const row = this.get(p.serverId);
    if (row?.machineId !== machineId) return;
    const uuid = p.uuid ?? `offline:${p.name.toLowerCase()}`;
    if (p.kind === 'join') {
      this.db
        .insert(players)
        .values({ uuid, lastName: p.name, firstSeenAt: p.ts, lastSeenAt: p.ts })
        .onConflictDoUpdate({ target: players.uuid, set: { lastName: p.name, lastSeenAt: p.ts } })
        .run();
      this.db
        .insert(playerSessions)
        .values({
          serverId: p.serverId,
          playerUuid: uuid,
          playerName: p.name,
          joinedAt: p.ts,
          leftAt: null,
        })
        .run();
    } else {
      const open = this.db
        .select()
        .from(playerSessions)
        .where(
          and(
            eq(playerSessions.serverId, p.serverId),
            eq(playerSessions.playerUuid, uuid),
            isNull(playerSessions.leftAt),
          ),
        )
        .all();
      for (const s of open) {
        this.db
          .update(playerSessions)
          .set({ leftAt: p.ts })
          .where(eq(playerSessions.id, s.id))
          .run();
      }
      this.db.update(players).set({ lastSeenAt: p.ts }).where(eq(players.uuid, uuid)).run();
    }
    this.deps.events.publish({
      type: p.kind === 'join' ? 'player.joined' : 'player.left',
      machineId,
      serverId: p.serverId,
      payload: { name: p.name, uuid: p.uuid ?? null, online: p.online },
      ts: p.ts,
    });
  }

  onlinePlayers(serverId: string) {
    return this.db
      .select()
      .from(playerSessions)
      .where(and(eq(playerSessions.serverId, serverId), isNull(playerSessions.leftAt)))
      .orderBy(asc(playerSessions.joinedAt))
      .all()
      .map((s) => ({
        name: s.playerName,
        uuid: s.playerUuid.startsWith('offline:') ? null : s.playerUuid,
        joinedAt: s.joinedAt,
      }));
  }

  /** Historique des connexions, du plus récent au plus ancien. */
  playerHistory(serverId: string, limit: number) {
    return this.db
      .select()
      .from(playerSessions)
      .where(eq(playerSessions.serverId, serverId))
      .orderBy(desc(playerSessions.joinedAt), desc(playerSessions.id))
      .limit(limit)
      .all()
      .map((s) => ({
        id: s.id,
        playerUuid: s.playerUuid.startsWith('offline:') ? null : s.playerUuid,
        playerName: s.playerName,
        joinedAt: s.joinedAt,
        leftAt: s.leftAt,
      }));
  }

  /** Règle de clôture (doc 04 §4) : sur stop/crash et à chaque réconciliation. */
  closePlayerSessions(serverId: string, ts: number): number {
    return this.db
      .update(playerSessions)
      .set({ leftAt: ts })
      .where(and(eq(playerSessions.serverId, serverId), isNull(playerSessions.leftAt)))
      .run().changes;
  }

  /**
   * Purge par rétention (doc 04 §8.6) : sessions **closes** seulement — une session ouverte est un
   * joueur en ligne, quelle que soit son ancienneté. Rend le nombre de lignes supprimées.
   */
  purgePlayerSessionsBefore(ts: number): number {
    return this.db
      .delete(playerSessions)
      .where(and(isNotNull(playerSessions.leftAt), lt(playerSessions.leftAt, ts)))
      .run().changes;
  }

  /** Au démarrage du panel : aucun agent connecté, les états « en marche » seront réconciliés. */
  countRunning(): number {
    return this.db.select().from(servers).where(ne(servers.runState, 'stopped')).all().length;
  }
}

function conflictKey(machineId: string, serverPath: string): string {
  return `${machineId}|${normalizePath(serverPath)}`;
}

/** Violation de l'index UNIQUE (machine_id, path) — signe d'une adoption concurrente du même chemin. */
function isUniquePathViolation(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE' &&
    error.message.includes('servers.machine_id')
  );
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function asExitReason(v: string | null): ServerDto['lastExitReason'] {
  return v === 'stop' || v === 'kill' || v === 'crash' || v === 'freeze_kill' ? v : null;
}
