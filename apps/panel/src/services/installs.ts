/**
 * Lot 5 — créer un serveur depuis le panel (doc 05 §6 « Installation », doc 07 §carnet post-1.0).
 *
 * L'ordre des gestes n'est pas négociable, et c'est tout l'intérêt du service :
 *
 * 1. **La ligne `servers` naît AVANT l'installation**, arrêtée (`desiredState = 'stopped'`,
 *    `provisioning = 'installing'`, `detected = 0`). Elle donne l'identité, le jail de `fs.*`, la
 *    politique de sauvegarde, et surtout : un scan qui tomberait sur le dossier en cours
 *    d'installation retrouve cette ligne par `findByPath` au lieu d'adopter un doublon (la course
 *    corrigée en 329c7e7). L'inverse — « l'agent installe puis le panel adopte » — rouvrirait tout
 *    cela d'un coup.
 * 2. **Le chemin n'est jamais libre** : il se compose d'un répertoire surveillé de la machine et
 *    d'un nom de dossier validé. Sans cette contrainte, ouvrir la création aux opérateurs d'une
 *    machine (lot 8) leur donnerait un jail de fichiers sur le chemin de leur choix.
 * 3. **La configuration n'est poussée à l'agent qu'après l'installation** : avant, le dossier
 *    n'existe pas, et écrire le marqueur y échouerait. L'agent n'a pas besoin de connaître le
 *    serveur pour l'installer — `server.install` porte son chemin.
 * 4. **`install_failed` est terminal** : ni un scan, ni la détection ne le repassent en `ready`.
 *    Une installation ratée qui a laissé un `server.properties` derrière elle ne doit pas se
 *    promouvoir toute seule en serveur démarrable.
 */
import { ulid, type RequestPayload } from '@mmo/protocol';
import type {
  CreateInstallInput,
  InstallPrecheckDto,
  InstallTargetDto,
  ServerDto,
} from '@mmo/protocol/client';
import { eq } from 'drizzle-orm';

import type { AgentRegistry } from '../agents/registry.js';
import type { MmoDatabase } from '../db/client.js';
import { servers, type ServerRow, type TaskRow } from '../db/schema.js';
import { AppError } from '../errors.js';
import type { EventBus } from './events.js';
import type { InstallCatalogService, InstallPlan } from './install-catalog.js';
import type { MachinesService } from './machines.js';
import { pickGamePort } from './migrations.js';
import type { ServersService } from './servers.js';
import type { TasksService } from './tasks.js';

export interface InstallsDeps {
  db: MmoDatabase;
  now: () => number;
  registry: AgentRegistry;
  machines: MachinesService;
  servers: ServersService;
  tasks: TasksService;
  catalog: InstallCatalogService;
  events: EventBus;
  logger: { warn: (obj: object, msg: string) => void; info: (obj: object, msg: string) => void };
  broadcast: (server: ServerDto) => void;
  /** Machine joignable ? (le DTO le porte, et le service ne le devine pas.) */
  reachable: (machineId: string) => boolean;
}

/**
 * Ce que le service reçoit : le corps de la requête, plus la machine — qui vient de l'URL
 * (`/api/machines/:id/install`) et non du corps, pour qu'il n'y ait qu'une seule autorité.
 */
export type InstallInput = Omit<CreateInstallInput, 'acceptEula'> & { machineId: string };

export interface PreparedInstall {
  target: InstallTargetDto;
  directoryId: string;
  machineId: string;
  plan: InstallPlan;
  name: string;
}

export class InstallsService {
  constructor(private readonly deps: InstallsDeps) {}

  /** Compose le chemin, choisit le port, construit le plan — sans rien écrire. */
  async prepare(input: InstallInput): Promise<PreparedInstall> {
    const machine = this.deps.machines.require(input.machineId);
    const dir = this.deps.machines.directories(machine.id).find((d) => d.id === input.directoryId);
    if (!dir) {
      throw new AppError('E_NOT_FOUND', 'unknown watched directory', {
        details: { reason: 'UNKNOWN_DIRECTORY', directoryId: input.directoryId },
      });
    }
    const sep = machine.os === 'windows' ? String.fromCharCode(92) : '/';
    const path = `${dir.path.replace(/[\\/]+$/, '')}${sep}${input.folderName}`;
    const existing = this.deps.servers.findByPath(machine.id, path);
    if (existing) {
      throw new AppError('E_CONFLICT', 'a server is already registered at this path', {
        details: { reason: 'PATH_TAKEN', serverId: existing.id, path },
      });
    }
    const plan = await this.deps.catalog.plan({
      loader: input.loader,
      mcVersion: input.mcVersion,
      ...(input.loaderVersion === undefined ? {} : { loaderVersion: input.loaderVersion }),
    });
    const used = new Set<number>();
    for (const row of this.deps.servers.listByMachine(machine.id)) {
      if (row.gamePort !== null) used.add(row.gamePort);
    }
    const gamePort = input.gamePort ?? pickGamePort(used, 25_565);
    return {
      machineId: machine.id,
      directoryId: dir.id,
      name: input.name ?? input.folderName,
      plan,
      target: {
        path,
        gamePort,
        javaMajor: plan.javaMajor ?? null,
        loaderVersion: plan.loaderVersion ?? null,
      },
    };
  }

  /**
   * Pré-contrôle sur la machine : dossier vide, port libre, JRE présent, espace disque.
   * `migration.precheck` est réutilisé **verbatim** — il pose exactement ces quatre questions.
   */
  async precheck(input: InstallInput): Promise<InstallPrecheckDto> {
    const prepared = await this.prepare(input);
    const session = this.deps.registry.require(prepared.machineId);
    const result = await session.peer.request('migration.precheck', {
      // Le serveur n'existe pas encore : l'id ne sert qu'au journal de l'agent.
      serverId: 'pending',
      path: prepared.target.path,
      gamePort: prepared.target.gamePort,
      ...(prepared.plan.javaMajor === undefined ? {} : { javaMajor: prepared.plan.javaMajor }),
      requiredBytes: estimateBytes(prepared.plan),
    });
    return { ...result, target: prepared.target };
  }

  /** Crée la ligne du serveur puis lance la task d'installation. */
  async create(
    input: InstallInput & { acceptEula: true },
    userId: string,
  ): Promise<{ server: ServerRow; taskId: string }> {
    const prepared = await this.prepare(input);
    const session = this.deps.registry.require(prepared.machineId);
    const serverId = ulid(this.deps.now());
    const taskId = ulid(this.deps.now());
    const row = this.deps.servers.insertPlanned({
      id: serverId,
      machineId: prepared.machineId,
      directoryId: prepared.directoryId,
      path: prepared.target.path,
      name: prepared.name,
      loader: prepared.plan.loader,
      mcVersion: prepared.plan.mcVersion,
      loaderVersion: prepared.plan.loaderVersion ?? null,
      javaMajorRequired: prepared.plan.javaMajor ?? null,
      maxRamMb: input.maxRamMb,
      minRamMb: input.minRamMb ?? Math.min(1024, input.maxRamMb),
      gamePort: prepared.target.gamePort,
    });
    const request = this.buildRequest(row, prepared.plan, {
      gamePort: prepared.target.gamePort,
      ...(input.motd === undefined ? {} : { motd: input.motd }),
    });
    this.deps.tasks.create({
      id: taskId,
      kind: 'server.install',
      machineId: prepared.machineId,
      serverId: row.id,
      createdBy: userId,
      request,
    });
    try {
      await session.peer.request('server.install', { taskId, ...request }, { userId });
    } catch (error) {
      // L'agent a refusé avant même de démarrer la task (chemin, dossier non vide, agent N-1) :
      // la ligne créée à l'instant n'a plus lieu d'être, et l'appelant reçoit l'erreur telle quelle.
      this.deps.tasks.fail(taskId, AppError.from(error).toJSON());
      this.deps.tasks.detachServer(taskId);
      this.deps.db.delete(servers).where(eq(servers.id, row.id)).run();
      throw error;
    }
    return { server: row, taskId };
  }

  /**
   * Mode « réparer » : rejoue le plan de la dernière installation, dans un dossier qui existe
   * déjà. C'est aussi ce qui débloque une installation interrompue par une coupure.
   */
  async repair(serverId: string, userId: string): Promise<{ taskId: string }> {
    const row = this.deps.servers.require(serverId);
    if (row.provisioning !== 'install_failed' && row.provisioning !== 'installing') {
      throw new AppError('E_CONFLICT', 'this server is not waiting for an installation', {
        details: { reason: 'NOT_INSTALLABLE', provisioning: row.provisioning },
      });
    }
    const previous = this.lastInstallRequest(serverId);
    if (previous === undefined) {
      throw new AppError('E_NOT_FOUND', 'no installation plan to replay', {
        details: { reason: 'NO_PLAN' },
      });
    }
    const session = this.deps.registry.require(row.machineId);
    const taskId = ulid(this.deps.now());
    const request = { ...previous, repair: true };
    this.deps.tasks.create({
      id: taskId,
      kind: 'server.install',
      machineId: row.machineId,
      serverId: row.id,
      createdBy: userId,
      request,
    });
    this.deps.servers.setProvisioning(row.id, 'installing');
    this.broadcastRow(row.id);
    try {
      await session.peer.request('server.install', { taskId, ...request }, { userId });
    } catch (error) {
      this.deps.tasks.fail(taskId, AppError.from(error).toJSON());
      this.deps.servers.setProvisioning(row.id, 'install_failed');
      this.broadcastRow(row.id);
      throw error;
    }
    return { taskId };
  }

  /** Issue de la task : le serveur devient utilisable, ou reste en échec — jamais entre les deux. */
  onTaskFinished(row: TaskRow, machineId: string): void {
    if (row.serverId === null) return;
    const server = this.deps.servers.get(row.serverId);
    if (!server) return;
    if (row.status !== 'done') {
      this.deps.servers.setProvisioning(server.id, 'install_failed');
      this.broadcastRow(server.id);
      return;
    }
    const result: Record<string, unknown> = this.deps.tasks.toDto(row).result ?? {};
    const updated = this.deps.servers.confirmInstalled(server.id, result.detected);
    this.deps.broadcast(this.deps.servers.toDto(updated, this.deps.reachable(updated.machineId)));
    // Le dossier existe enfin : l'agent peut recevoir la configuration (et écrire le marqueur).
    void this.deps.registry
      .get(machineId)
      ?.pushConfig()
      .catch((error: unknown) => {
        this.deps.logger.warn(
          { machineId, serverId: server.id, error: String(error) },
          'install: pushing config failed',
        );
      });
  }

  private broadcastRow(serverId: string): void {
    const row = this.deps.servers.require(serverId);
    this.deps.broadcast(this.deps.servers.toDto(row, this.deps.reachable(row.machineId)));
  }

  private buildRequest(
    row: ServerRow,
    plan: InstallPlan,
    settings: { gamePort: number; motd?: string },
  ): Omit<RequestPayload<'server.install'>, 'taskId'> {
    const values: Record<string, string> = {
      'server-port': String(settings.gamePort),
      'query.port': String(settings.gamePort),
    };
    if (settings.motd !== undefined && settings.motd !== '') values.motd = settings.motd;
    return {
      serverId: row.id,
      path: row.path,
      loader: plan.loader,
      mcVersion: plan.mcVersion,
      ...(plan.loaderVersion === undefined ? {} : { loaderVersion: plan.loaderVersion }),
      // L'EULA est un drapeau appliqué APRÈS les étapes, jamais une étape (doc 06 §6ter).
      acceptEula: true,
      repair: false,
      steps: [...plan.steps, { kind: 'setProperties', path: 'server.properties', values }],
    };
  }

  /** Dernière requête d'installation connue pour ce serveur (la plus récente d'abord). */
  private lastInstallRequest(
    serverId: string,
  ): Omit<RequestPayload<'server.install'>, 'taskId'> | undefined {
    for (const task of this.deps.tasks.list({ serverId, limit: 20 })) {
      if (task.kind !== 'server.install') continue;
      const request = this.deps.tasks.requestOf(task.id);
      if (request !== undefined) {
        return request as Omit<RequestPayload<'server.install'>, 'taskId'>;
      }
    }
    return undefined;
  }
}

/** Estimation grossière pour la garde d'espace : ce qu'on télécharge, doublé, plus 256 Mio. */
function estimateBytes(plan: InstallPlan): number {
  let known = 0;
  for (const step of plan.steps) {
    if (step.kind === 'download' && step.size !== undefined) known += step.size;
  }
  return known * 2 + 256 * 1024 * 1024;
}
