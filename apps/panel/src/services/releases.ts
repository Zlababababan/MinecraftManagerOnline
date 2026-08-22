/**
 * Releases d'agent (doc 04 §2 `agent_releases`, doc 03 §3, doc 05 §9) : bundles universels publiés
 * par l'admin (`PUT /api/admin/agent-releases`, corps = bundle, signature Ed25519 produite hors
 * panel avec `tools/signing/sign.mjs`), stockés sous `<dataDir>/releases/`. `agent.update` pousse
 * `{ version, url (jeton de relais), sha256, signature }` ; mise à jour automatique à la connexion si
 * `agents.autoUpdate` est activé. L'issue (`agent.updateResult`) est journalisée en événement + audit.
 */
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { PROTOCOL_VERSION, type ParsedEventPayload } from '@mmo/protocol';
import type { AgentReleaseDto } from '@mmo/protocol/client';
import { compareVersions } from '@mmo/shared';
import { desc, eq } from 'drizzle-orm';

import type { AgentRegistry } from '../agents/registry.js';
import type { MmoDatabase } from '../db/client.js';
import { agentReleases, type AgentReleaseRow } from '../db/schema.js';
import { AppError, conflict, notFound } from '../errors.js';
import type { AuditService } from './audit.js';
import type { EventBus } from './events.js';
import type { MachinesService } from './machines.js';
import { relayUrl, type RelayTokens } from './relay.js';
import { SETTING_KEYS, type SettingsService } from './settings.js';

export interface ReleasesServiceDeps {
  db: MmoDatabase;
  now: () => number;
  dataDir: string;
  registry: AgentRegistry;
  relay: RelayTokens;
  machines: MachinesService;
  settings: SettingsService;
  events: EventBus;
  audit: AuditService;
}

export interface PublishInput {
  version: string;
  signature: string;
  protocolVersion?: number | undefined;
  channel?: string | undefined;
  runtimeVersion?: string | undefined;
  notes?: string | undefined;
}

const RELAY_TTL_MS = 30 * 60_000;

export class ReleasesService {
  constructor(private readonly deps: ReleasesServiceDeps) {}

  get directory(): string {
    return path.join(this.deps.dataDir, 'releases');
  }

  list(): AgentReleaseRow[] {
    return this.deps.db.select().from(agentReleases).orderBy(desc(agentReleases.releasedAt)).all();
  }

  get(version: string): AgentReleaseRow | undefined {
    return this.deps.db
      .select()
      .from(agentReleases)
      .where(eq(agentReleases.version, version))
      .get();
  }

  require(version: string): AgentReleaseRow {
    const row = this.get(version);
    if (!row) throw notFound('release', version);
    return row;
  }

  /** Version la plus récente (ordre sémantique) d'un canal. */
  latest(channel = 'stable'): AgentReleaseRow | undefined {
    const rows = this.list().filter((r) => r.channel === channel);
    return rows.sort((a, b) => compareVersions(b.version, a.version))[0];
  }

  toDto(row: AgentReleaseRow): AgentReleaseDto {
    return {
      version: row.version,
      protocolVersion: row.protocolVersion,
      channel: row.channel,
      releasedAt: row.releasedAt,
      sha256: row.bundleSha256,
      size: row.bundleSize,
      runtimeVersion: row.runtimeVersion,
      notes: row.notes,
      signature: row.bundleSignature,
    };
  }

  /** Enregistre un bundle (flux) : écrit le fichier, calcule sha256 + taille. La signature est fournie. */
  async publish(input: PublishInput, body: Readable): Promise<AgentReleaseRow> {
    if (this.get(input.version)) throw conflict(`release ${input.version} already exists`);
    await mkdir(this.directory, { recursive: true });
    const file = path.join(this.directory, `agent-${sanitize(input.version)}.js`);
    const hash = createHash('sha256');
    let size = 0;
    body.on('data', (chunk: Buffer) => {
      hash.update(chunk);
      size += chunk.byteLength;
    });
    await pipeline(body, createWriteStream(file));
    if (size === 0) {
      await rm(file, { force: true });
      throw new AppError('E_VALIDATION', 'empty bundle');
    }
    const row = {
      version: input.version,
      protocolVersion: input.protocolVersion ?? PROTOCOL_VERSION,
      channel: input.channel ?? 'stable',
      releasedAt: this.deps.now(),
      bundlePath: file,
      bundleSha256: hash.digest('hex'),
      bundleSignature: input.signature,
      bundleSize: size,
      runtimeVersion: input.runtimeVersion ?? null,
      notes: input.notes ?? null,
    };
    this.deps.db.insert(agentReleases).values(row).run();
    return this.require(input.version);
  }

  async delete(version: string): Promise<void> {
    const row = this.require(version);
    this.deps.db.delete(agentReleases).where(eq(agentReleases.version, version)).run();
    await rm(row.bundlePath, { force: true }).catch(() => undefined);
  }

  /** Une mise à jour est-elle disponible pour cette version d'agent ? */
  updateAvailable(agentVersion: string | null, channel = 'stable'): string | undefined {
    const latest = this.latest(channel);
    if (!latest || agentVersion === null) return undefined;
    return compareVersions(latest.version, agentVersion) > 0 ? latest.version : undefined;
  }

  /** Pousse `agent.update` (version donnée ou dernière release stable) à un agent connecté. */
  async pushUpdate(
    machineId: string,
    version: string | undefined,
    userId?: string,
  ): Promise<{ version: string; alreadyCurrent: boolean }> {
    const release = version === undefined ? this.latest() : this.get(version);
    if (!release) throw new AppError('E_NO_RELEASE', 'no agent release available');
    const st = await stat(release.bundlePath).catch(() => undefined);
    if (!st?.isFile()) throw new AppError('E_NO_RELEASE', 'bundle file missing on disk');
    const session = this.deps.registry.require(machineId);
    const token = this.deps.relay.issue(
      {
        kind: 'bundle',
        version: release.version,
        file: release.bundlePath,
        size: release.bundleSize,
        fileName: path.basename(release.bundlePath),
      },
      RELAY_TTL_MS,
    );
    const res = await session.peer.request(
      'agent.update',
      {
        version: release.version,
        url: relayUrl(token),
        sha256: release.bundleSha256,
        signature: release.bundleSignature,
        size: release.bundleSize,
        ...(release.runtimeVersion === null ? {} : { runtimeVersion: release.runtimeVersion }),
      },
      userId === undefined ? {} : { userId },
    );
    this.deps.events.publish({
      type: 'agent.updatePushed',
      machineId,
      userId,
      payload: {
        version: release.version,
        from: res.currentVersion,
        alreadyCurrent: res.alreadyCurrent,
      },
    });
    return { version: release.version, alreadyCurrent: res.alreadyCurrent };
  }

  /** À la connexion : mise à jour automatique si activée et si une release plus récente existe. */
  async maybeAutoUpdate(machineId: string, agentVersion: string): Promise<boolean> {
    if (!this.deps.settings.getBool(SETTING_KEYS.autoUpdate)) return false;
    const target = this.updateAvailable(agentVersion);
    if (target === undefined) return false;
    await this.pushUpdate(machineId, target);
    return true;
  }

  /** `agent.updateResult` (critique) : événement + audit ; version courante relue de `auth.hello`. */
  applyUpdateResult(machineId: string, p: ParsedEventPayload<'agent.updateResult'>): void {
    const machine = this.deps.machines.get(machineId);
    this.deps.events.publish({
      type: p.status === 'applied' ? 'agent.updateApplied' : 'agent.updateRolledBack',
      severity: p.status === 'applied' ? 'info' : 'error',
      machineId,
      payload: {
        kind: p.kind,
        version: p.version,
        otherVersion: p.otherVersion ?? null,
        reason: p.reason ?? null,
      },
      ts: p.ts,
    });
    this.deps.audit.record({
      action: `agent.update.${p.status}`,
      targetType: 'machine',
      targetId: machineId,
      targetLabel: machine?.name,
      details: {
        kind: p.kind,
        version: p.version,
        otherVersion: p.otherVersion ?? null,
        reason: p.reason ?? null,
      },
    });
  }
}

function sanitize(v: string): string {
  return v.replace(/[^A-Za-z0-9_.+-]/g, '_');
}
