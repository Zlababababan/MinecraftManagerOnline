/**
 * Machines, appairage et secrets d'agent (doc 04 §2, doc 05 §3). Codes d'appairage hachés, TTL
 * 15 min, usage unique, 5 essais ; secret 256 bits dont seul le SHA-256 est stocké ; rotation avec
 * les deux secrets valides 24 h ; révocation = suppression/désactivation de la machine.
 */
import { ProtocolError, ulid, type RequestPayload } from '@mmo/protocol';
import { and, asc, eq, gt, isNull, lt, ne, sql } from 'drizzle-orm';

import type { MmoDatabase } from '../db/client.js';
import {
  machines,
  pairingCodes,
  servers,
  watchedDirectories,
  type MachineRow,
  type WatchedDirectoryRow,
} from '../db/schema.js';
import { conflict, notFound } from '../errors.js';
import {
  generateAgentSecret,
  generatePairingCode,
  hashPairingCode,
  safeEqualHex,
  sha256Hex,
} from '../util/crypto.js';

export const PAIRING_TTL_MS = 15 * 60_000;
export const PAIRING_MAX_ATTEMPTS = 5;
export const SECRET_GRACE_MS = 24 * 3_600_000;

type MachineInfo = RequestPayload<'pair.request'>['machine'];

export interface PairingResult {
  machine: MachineRow;
  secret: string;
}

export class MachinesService {
  constructor(
    private readonly db: MmoDatabase,
    private readonly now: () => number,
  ) {}

  list(): MachineRow[] {
    return this.db.select().from(machines).orderBy(asc(machines.createdAt)).all();
  }

  get(id: string): MachineRow | undefined {
    return this.db.select().from(machines).where(eq(machines.id, id)).get();
  }

  require(id: string): MachineRow {
    const row = this.get(id);
    if (!row) throw notFound('machine', id);
    return row;
  }

  create(name: string): MachineRow {
    const existing = this.db.select().from(machines).where(eq(machines.name, name)).get();
    if (existing) throw conflict(`machine name ${name} already exists`, { name });
    const row: MachineRow = {
      id: ulid(this.now()),
      name,
      os: null,
      arch: null,
      hostname: null,
      agentVersion: null,
      protocolVersion: null,
      agentTokenHash: null,
      agentTokenPrevHash: null,
      agentTokenPrevUntil: null,
      status: 'pending',
      lastSeenAt: null,
      cpuModel: null,
      cpuCores: null,
      ramTotalMb: null,
      createdAt: this.now(),
      runtimeVersion: null,
    };
    this.db.insert(machines).values(row).run();
    return row;
  }

  update(id: string, patch: { name?: string | undefined; disabled?: boolean | undefined }) {
    const current = this.require(id);
    const set: Partial<MachineRow> = {};
    if (patch.name !== undefined && patch.name !== current.name) {
      if (this.db.select().from(machines).where(eq(machines.name, patch.name)).get()) {
        throw conflict(`machine name ${patch.name} already exists`, { name: patch.name });
      }
      set.name = patch.name;
    }
    if (patch.disabled !== undefined) {
      if (patch.disabled) set.status = 'disabled';
      else if (current.status === 'disabled')
        set.status = current.agentTokenHash === null ? 'pending' : 'offline';
    }
    if (Object.keys(set).length > 0)
      this.db.update(machines).set(set).where(eq(machines.id, id)).run();
    return this.require(id);
  }

  /** Suppression = révocation : serveurs, répertoires et codes de la machine partent avec elle. */
  delete(id: string): void {
    this.require(id);
    this.db.transaction((tx) => {
      tx.delete(servers).where(eq(servers.machineId, id)).run();
      tx.delete(machines).where(eq(machines.id, id)).run();
    });
  }

  // --- Appairage ------------------------------------------------------------------------------

  /** Nouveau code pour une machine (invalide les codes précédents de cette machine). */
  createPairingCode(machineId: string, createdBy: string | undefined) {
    const machine = this.require(machineId);
    if (machine.status === 'disabled') throw conflict('machine is disabled', { machineId });
    const code = generatePairingCode();
    const createdAt = this.now();
    const expiresAt = createdAt + PAIRING_TTL_MS;
    this.db.transaction((tx) => {
      tx.delete(pairingCodes)
        .where(and(eq(pairingCodes.machineId, machineId), isNull(pairingCodes.usedAt)))
        .run();
      tx.insert(pairingCodes)
        .values({
          codeHash: hashPairingCode(code),
          attempts: 0,
          createdBy: createdBy ?? null,
          createdAt,
          expiresAt,
          usedAt: null,
          machineId,
        })
        .run();
    });
    return { code, expiresAt };
  }

  /**
   * Consomme un code (doc 05 §3) : hash comparé, TTL, usage unique, compteur d'essais. Un code
   * inconnu incrémente les essais de tous les codes actifs (un code ne pouvant être identifié,
   * 5 tentatives ratées brûlent les codes en attente — l'admin en régénère un).
   */
  consumePairingCode(
    code: string,
    info: { machine: MachineInfo; agentVersion: string; protocolVersion: number },
  ): PairingResult {
    const t = this.now();
    const active = and(isNull(pairingCodes.usedAt), gt(pairingCodes.expiresAt, t));
    const row = this.db
      .select()
      .from(pairingCodes)
      .where(and(eq(pairingCodes.codeHash, hashPairingCode(code)), active))
      .get();
    if (!row || row.attempts >= PAIRING_MAX_ATTEMPTS || row.machineId === null) {
      this.db
        .update(pairingCodes)
        .set({ attempts: sql`${pairingCodes.attempts} + 1` })
        .where(active)
        .run();
      throw new ProtocolError(
        'E_PAIRING_CODE_INVALID',
        'invalid, expired or exhausted pairing code',
      );
    }
    const machine = this.get(row.machineId);
    if (!machine || machine.status === 'disabled') {
      throw new ProtocolError(
        'E_PAIRING_CODE_INVALID',
        'pairing code bound to an unusable machine',
      );
    }
    const secret = generateAgentSecret();
    this.db.transaction((tx) => {
      tx.update(pairingCodes).set({ usedAt: t }).where(eq(pairingCodes.id, row.id)).run();
      tx.update(machines)
        .set({
          ...machineColumns(info.machine),
          agentVersion: info.agentVersion,
          protocolVersion: info.protocolVersion,
          agentTokenHash: sha256Hex(secret),
          agentTokenPrevHash: null,
          agentTokenPrevUntil: null,
          status: 'offline',
          lastSeenAt: t,
        })
        .where(eq(machines.id, machine.id))
        .run();
    });
    return { machine: this.require(machine.id), secret };
  }

  /** `auth.hello` : secret courant ou ancien secret en période de grâce. */
  authenticate(agentId: string, secret: string): MachineRow {
    const machine = this.get(agentId);
    if (!machine || machine.status === 'disabled' || machine.agentTokenHash === null) {
      throw new ProtocolError('E_AUTH', 'unknown, unpaired or disabled agent');
    }
    const hash = sha256Hex(secret);
    if (safeEqualHex(hash, machine.agentTokenHash)) return machine;
    if (
      machine.agentTokenPrevHash !== null &&
      machine.agentTokenPrevUntil !== null &&
      machine.agentTokenPrevUntil > this.now() &&
      safeEqualHex(hash, machine.agentTokenPrevHash)
    ) {
      return machine;
    }
    throw new ProtocolError('E_AUTH', 'invalid agent secret');
  }

  /** Prépare une rotation : retourne le nouveau secret à pousser via `agent.rotateSecret`. */
  beginRotation(machineId: string): { secret: string; graceUntil: number } {
    this.require(machineId);
    return { secret: generateAgentSecret(), graceUntil: this.now() + SECRET_GRACE_MS };
  }

  /** À appeler une fois l'agent d'accord : l'ancien hash reste valide jusqu'à `graceUntil`. */
  commitRotation(machineId: string, secret: string, graceUntil: number): void {
    const machine = this.require(machineId);
    this.db
      .update(machines)
      .set({
        agentTokenHash: sha256Hex(secret),
        agentTokenPrevHash: machine.agentTokenHash,
        agentTokenPrevUntil: graceUntil,
      })
      .where(eq(machines.id, machineId))
      .run();
  }

  // --- Présence ----------------------------------------------------------------------------------

  markOnline(
    machineId: string,
    info: {
      machine?: MachineInfo | undefined;
      agentVersion: string;
      protocolVersion: number;
      runtimeVersion?: string | undefined;
    },
  ): void {
    this.db
      .update(machines)
      .set({
        ...(info.machine === undefined ? {} : machineColumns(info.machine)),
        agentVersion: info.agentVersion,
        ...(info.runtimeVersion === undefined ? {} : { runtimeVersion: info.runtimeVersion }),
        protocolVersion: info.protocolVersion,
        status: 'online',
        lastSeenAt: this.now(),
      })
      .where(and(eq(machines.id, machineId), ne(machines.status, 'disabled')))
      .run();
  }

  touch(machineId: string): void {
    this.db
      .update(machines)
      .set({ lastSeenAt: this.now() })
      .where(eq(machines.id, machineId))
      .run();
  }

  markOffline(machineId: string): void {
    this.db
      .update(machines)
      .set({ status: 'offline' })
      .where(and(eq(machines.id, machineId), eq(machines.status, 'online')))
      .run();
  }

  /** Au démarrage du panel : aucune session n'existe encore, tout `online` est un reliquat. */
  markAllOffline(): void {
    this.db.update(machines).set({ status: 'offline' }).where(eq(machines.status, 'online')).run();
  }

  // --- Répertoires surveillés ----------------------------------------------------------------------

  directories(machineId: string): WatchedDirectoryRow[] {
    return this.db
      .select()
      .from(watchedDirectories)
      .where(eq(watchedDirectories.machineId, machineId))
      .orderBy(asc(watchedDirectories.path))
      .all();
  }

  addDirectory(machineId: string, dirPath: string): WatchedDirectoryRow {
    this.require(machineId);
    const existing = this.db
      .select()
      .from(watchedDirectories)
      .where(and(eq(watchedDirectories.machineId, machineId), eq(watchedDirectories.path, dirPath)))
      .get();
    if (existing) throw conflict('directory already watched', { path: dirPath });
    const row: WatchedDirectoryRow = {
      id: ulid(this.now()),
      machineId,
      path: dirPath,
      enabled: 1,
      lastScanAt: null,
    };
    this.db.insert(watchedDirectories).values(row).run();
    return row;
  }

  removeDirectory(machineId: string, directoryId: string): void {
    const r = this.db
      .delete(watchedDirectories)
      .where(
        and(eq(watchedDirectories.id, directoryId), eq(watchedDirectories.machineId, machineId)),
      )
      .run();
    if (r.changes === 0) throw notFound('directory', directoryId);
  }

  markScanned(machineId: string): void {
    this.db
      .update(watchedDirectories)
      .set({ lastScanAt: this.now() })
      .where(eq(watchedDirectories.machineId, machineId))
      .run();
  }

  purgeExpiredPairingCodes(): number {
    return this.db.delete(pairingCodes).where(lt(pairingCodes.expiresAt, this.now())).run().changes;
  }
}

function machineColumns(info: MachineInfo): Partial<MachineRow> {
  return {
    os: info.os,
    arch: info.arch,
    hostname: info.hostname,
    cpuModel: info.cpuModel ?? null,
    cpuCores: info.cpuCores ?? null,
    ramTotalMb: info.ramTotalMb ?? null,
  };
}
