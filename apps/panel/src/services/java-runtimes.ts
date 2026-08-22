/**
 * Java géré côté panel (doc 03 §4, doc 04 §2 `java_runtimes`, doc 05 §6 « Java ») : inventaire des
 * runtimes remonté par les agents (`sync.state.javaRuntimes`, `java.list`), et `java.install` dont le
 * panel décide la **chaîne ordonnée de sources** (Temurin → Zulu → x64 émulé) en interrogeant les API
 * des fournisseurs ; en **mode relais** (machine sans Internet sortant) le panel télécharge l'archive
 * dans `<dataDir>/jre-cache/` et la sert à l'agent via un jeton de relais.
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { ulid, type JavaRuntime, type JavaSource } from '@mmo/protocol';
import type { InstallJavaInput, JavaRuntimeDto } from '@mmo/protocol/client';
import {
  archiveFor,
  javaCandidates,
  parseTemurinAssets,
  parseZuluDetail,
  parseZuluPackages,
  zuluPackageDetailUrl,
  type JavaArch,
  type JavaOs,
} from '@mmo/shared';
import { and, eq } from 'drizzle-orm';

import type { AgentRegistry } from '../agents/registry.js';
import type { MmoDatabase } from '../db/client.js';
import { javaRuntimes, servers, type JavaRuntimeRow, type MachineRow } from '../db/schema.js';
import { AppError, notFound } from '../errors.js';
import { relayUrl, type RelayTokens } from './relay.js';
import type { TasksService } from './tasks.js';

export interface JavaRuntimesDeps {
  db: MmoDatabase;
  now: () => number;
  dataDir: string;
  registry: AgentRegistry;
  relay: RelayTokens;
  tasks: TasksService;
  fetchImpl: typeof fetch | undefined;
  logger: { warn: (obj: object, msg: string) => void; info: (obj: object, msg: string) => void };
}

const RELAY_TTL_MS = 60 * 60_000;

export class JavaRuntimesService {
  constructor(private readonly deps: JavaRuntimesDeps) {}

  // --- Inventaire -----------------------------------------------------------------------------

  list(machineId: string): JavaRuntimeRow[] {
    return this.deps.db
      .select()
      .from(javaRuntimes)
      .where(eq(javaRuntimes.machineId, machineId))
      .all()
      .sort((a, b) => b.majorVersion - a.majorVersion || a.path.localeCompare(b.path));
  }

  get(id: string): JavaRuntimeRow | undefined {
    return this.deps.db.select().from(javaRuntimes).where(eq(javaRuntimes.id, id)).get();
  }

  toDto(row: JavaRuntimeRow): JavaRuntimeDto {
    const usedBy = this.deps.db
      .select({ id: servers.id })
      .from(servers)
      .where(
        and(eq(servers.machineId, row.machineId), eq(servers.javaMajorRequired, row.majorVersion)),
      )
      .all().length;
    return {
      id: row.id,
      machineId: row.machineId,
      majorVersion: row.majorVersion,
      fullVersion: row.fullVersion,
      vendor: row.vendor,
      path: row.path,
      managed: row.managed === 1,
      installedAt: row.installedAt,
      usedBy,
    };
  }

  /** Remplace l'inventaire d'une machine par celui annoncé par l'agent (ids stables par chemin). */
  sync(machineId: string, runtimes: JavaRuntime[]): JavaRuntimeRow[] {
    const existing = new Map(this.list(machineId).map((r) => [r.path, r]));
    const seen = new Set<string>();
    for (const rt of runtimes) {
      seen.add(rt.path);
      const row = existing.get(rt.path);
      if (row) {
        this.deps.db
          .update(javaRuntimes)
          .set({
            majorVersion: rt.majorVersion,
            fullVersion: rt.fullVersion ?? null,
            vendor: rt.vendor,
            managed: rt.managed ? 1 : 0,
          })
          .where(eq(javaRuntimes.id, row.id))
          .run();
      } else {
        this.deps.db
          .insert(javaRuntimes)
          .values({
            id: ulid(this.deps.now()),
            machineId,
            majorVersion: rt.majorVersion,
            fullVersion: rt.fullVersion ?? null,
            vendor: rt.vendor,
            path: rt.path,
            managed: rt.managed ? 1 : 0,
            installedAt: this.deps.now(),
          })
          .run();
      }
    }
    for (const [p, row] of existing) {
      if (!seen.has(p)) this.deps.db.delete(javaRuntimes).where(eq(javaRuntimes.id, row.id)).run();
    }
    return this.list(machineId);
  }

  /** Rafraîchit depuis l'agent s'il est connecté (`java.list`), sinon rend l'inventaire connu. */
  async refresh(machineId: string): Promise<JavaRuntimeRow[]> {
    const session = this.deps.registry.get(machineId);
    if (!session) return this.list(machineId);
    try {
      const { runtimes } = await session.peer.request('java.list', {});
      return this.sync(machineId, runtimes);
    } catch (error) {
      this.deps.logger.warn({ machineId, err: error }, 'java.list failed');
      return this.list(machineId);
    }
  }

  // --- Installation ---------------------------------------------------------------------------

  /**
   * Construit la chaîne de sources pour une machine : API Temurin puis Zulu (puis x64 émulé sur ARM),
   * chaque combo absent (404) étant simplement sauté. En mode relais, les archives sont téléchargées par
   * le panel et servies via des jetons.
   */
  async planSources(
    machine: Pick<MachineRow, 'os' | 'arch'>,
    input: InstallJavaInput,
  ): Promise<JavaSource[]> {
    if (machine.os === null || machine.arch === null) {
      throw new AppError('E_CONFLICT', 'machine platform unknown (never connected)');
    }
    const os: JavaOs = machine.os;
    const arch: JavaArch = machine.arch;
    const doFetch = this.deps.fetchImpl ?? fetch;
    const sources: JavaSource[] = [];
    for (const c of javaCandidates(input.majorVersion, os, arch)) {
      if (input.vendor !== undefined && c.vendor !== input.vendor) continue;
      let source: (JavaSource & { packageUuid?: string }) | undefined;
      try {
        const res = await doFetch(c.metadataUrl, { headers: { accept: 'application/json' } });
        if (!res.ok) continue; // 404 = combo indisponible (cas normal)
        const json: unknown = await res.json();
        source =
          c.vendor === 'temurin'
            ? parseTemurinAssets(json, os, c.emulated)
            : parseZuluPackages(json, os, c.emulated);
        if (source && c.vendor === 'zulu' && source.sha256 === undefined && source.packageUuid) {
          const detail = await doFetch(zuluPackageDetailUrl(source.packageUuid));
          const sha = detail.ok ? parseZuluDetail(await detail.json()) : undefined;
          if (sha !== undefined) source.sha256 = sha;
        }
      } catch (error) {
        this.deps.logger.warn({ url: c.metadataUrl, err: error }, 'java provider unreachable');
        continue;
      }
      if (!source) continue;
      const { packageUuid: _uuid, ...clean } = source;
      sources.push(clean);
    }
    if (sources.length === 0) {
      throw new AppError('E_JAVA_UNAVAILABLE', 'no provider offers this runtime for the platform', {
        details: { majorVersion: input.majorVersion, os, arch },
      });
    }
    if (!input.relay) return sources;
    // Mode relais : le panel télécharge la première source disponible et la sert à l'agent.
    const relayed: JavaSource[] = [];
    for (const s of sources) {
      try {
        const cached = await this.cacheArchive(s, archiveFor(os));
        const token = this.deps.relay.issue(
          { kind: 'java', file: cached.file, size: cached.size, fileName: cached.fileName },
          RELAY_TTL_MS,
        );
        relayed.push({
          ...s,
          url: relayUrl(token),
          sha256: cached.sha256,
          size: cached.size,
          relay: true,
        });
        break;
      } catch (error) {
        this.deps.logger.warn({ url: s.url, err: error }, 'java relay download failed');
      }
    }
    if (relayed.length === 0) {
      throw new AppError('E_IO', 'panel could not download any runtime archive for relay', {
        retryable: true,
      });
    }
    return relayed;
  }

  /** Lance la task `java.install` sur l'agent (ligne `tasks` créée avant l'ordre). */
  async install(
    machine: MachineRow,
    input: InstallJavaInput,
    userId: string | undefined,
  ): Promise<{ taskId: string; sources: JavaSource[] }> {
    const session = this.deps.registry.require(machine.id);
    const sources = await this.planSources(machine, input);
    const taskId = ulid(this.deps.now());
    this.deps.tasks.create({
      id: taskId,
      kind: 'java.install',
      machineId: machine.id,
      createdBy: userId,
      request: { majorVersion: input.majorVersion, relay: input.relay, sources: sources.length },
    });
    try {
      await session.peer.request(
        'java.install',
        { taskId, majorVersion: input.majorVersion, sources },
        userId === undefined ? {} : { userId },
      );
      this.deps.tasks.markRunning(taskId);
    } catch (error) {
      this.deps.tasks.fail(taskId, AppError.from(error).toJSON());
      throw error;
    }
    return { taskId, sources };
  }

  async remove(machineId: string, runtimeId: string): Promise<boolean> {
    const row = this.get(runtimeId);
    if (row?.machineId !== machineId) throw notFound('java runtime', runtimeId);
    if (row.managed !== 1) throw new AppError('E_CONFLICT', 'only managed runtimes can be removed');
    const session = this.deps.registry.require(machineId);
    const { removed } = await session.peer.request('java.remove', { path: row.path });
    this.deps.db.delete(javaRuntimes).where(eq(javaRuntimes.id, row.id)).run();
    return removed;
  }

  // --- Cache relais ---------------------------------------------------------------------------

  get cacheDir(): string {
    return path.join(this.deps.dataDir, 'jre-cache');
  }

  private async cacheArchive(
    source: JavaSource,
    archive: 'zip' | 'tar.gz',
  ): Promise<{ file: string; size: number; sha256: string; fileName: string }> {
    await mkdir(this.cacheDir, { recursive: true });
    const name = `${source.vendor}-${createHash('sha1').update(source.url).digest('hex').slice(0, 12)}.${archive}`;
    const file = path.join(this.cacheDir, name);
    const existing = await stat(file).catch(() => undefined);
    if (existing?.isFile() && (source.size === undefined || existing.size === source.size)) {
      const sha = await sha256File(file);
      if (source.sha256 === undefined || source.sha256 === sha) {
        return { file, size: existing.size, sha256: sha, fileName: name };
      }
    }
    const doFetch = this.deps.fetchImpl ?? fetch;
    const res = await doFetch(source.url, { redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`HTTP ${String(res.status)} from ${source.url}`);
    const part = `${file}.part`;
    const hash = createHash('sha256');
    let size = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        hash.update(chunk);
        size += chunk.byteLength;
        cb(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body as never), counter, createWriteStream(part));
    const sha = hash.digest('hex');
    if (source.sha256 !== undefined && source.sha256 !== sha) {
      await rm(part, { force: true });
      throw new Error('downloaded runtime does not match the provider checksum');
    }
    await rm(file, { force: true });
    await rename(part, file);
    return { file, size, sha256: sha, fileName: name };
  }
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
