/**
 * Phase 8 — tasks (suivi, annulation), backups (créer / restaurer / supprimer / télécharger,
 * politiques poussées à l'agent), planificateur du panel (actions programmées), transferts
 * (download/upload de l'explorateur), spark en un clic, sauvegarde du panel (`VACUUM INTO`).
 */
import { createReadStream, statSync } from 'node:fs';

import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { ulid } from '@mmo/protocol';
import {
  backupPolicyInputSchema,
  createBackupSchema,
  fsPathQuerySchema,
  restoreBackupSchema,
  restorePathsSchema,
  scheduledTaskInputSchema,
  tasksQuerySchema,
  uploadQuerySchema,
  type SparkStatus,
} from '@mmo/protocol/client';

import type { AppContext } from '../../context.js';
import type { ServerRow } from '../../db/schema.js';
import { AppError, conflict, notFound } from '../../errors.js';
import { requireUser } from '../auth.js';
import { auditMeta } from './setup-auth.js';

const idParams = z.object({ id: z.string().min(1) });
const backupParams = z.object({ id: z.string().min(1), backupId: z.string().min(1) });
const policyParams = z.object({ id: z.string().min(1), policyId: z.string().min(1) });
const scheduleParams = z.object({ id: z.string().min(1), scheduleId: z.string().min(1) });

/** Plateformes spark par loader (le jar est servi par spark : `https://spark.lucko.me/download`). */
const SPARK_PLATFORMS: Record<string, string> = {
  forge: 'forge',
  neoforge: 'neoforge',
  fabric: 'fabric',
};
const SPARK_API = 'https://sparkapi.lucko.me/download';

export function registerTaskRoutes(app: FastifyInstance, ctx: AppContext): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const session = (serverId: string) => {
    const row = ctx.servers.require(serverId);
    return { row, peer: ctx.registry.require(row.machineId).peer };
  };
  const ensureIdle = (row: ServerRow): void => {
    const active = ctx.tasks
      .list({ serverId: row.id, active: true })
      .find(
        (t) =>
          t.kind === 'backup.create' ||
          t.kind === 'backup.restore' ||
          t.kind === 'backup.restorePaths',
      );
    if (active) {
      throw new AppError('E_BUSY', 'a backup task is already running for this server', {
        details: { taskId: active.id, kind: active.kind },
        retryable: true,
      });
    }
  };

  // --- Tasks ----------------------------------------------------------------------------------

  r.get('/api/tasks', { schema: { querystring: tasksQuerySchema } }, (request) => ({
    tasks: ctx.tasks.list(request.query).map((t) => ctx.tasks.toDto(t)),
  }));

  r.get('/api/tasks/:id', { schema: { params: idParams } }, (request) => ({
    task: ctx.tasks.toDto(ctx.tasks.require(request.params.id)),
  }));

  r.post(
    '/api/tasks/:id/cancel',
    { config: { role: 'operator' }, schema: { params: idParams } },
    async (request) => {
      const task = ctx.tasks.require(request.params.id);
      if (task.machineId === null) throw conflict('task without machine');
      const peer = ctx.registry.require(task.machineId).peer;
      const res = await peer.request('task.cancel', { taskId: task.id });
      ctx.audit.record({
        ...auditMeta(request),
        action: 'task.cancel',
        targetType: 'task',
        targetId: task.id,
        details: { kind: task.kind, cancelled: res.cancelled },
      });
      return { cancelled: res.cancelled, task: ctx.tasks.toDto(ctx.tasks.require(task.id)) };
    },
  );

  // --- Backups ----------------------------------------------------------------------------------

  r.get('/api/servers/:id/backups', { schema: { params: idParams } }, (request) => {
    const row = ctx.servers.require(request.params.id);
    return {
      backups: ctx.backups.list(row.id).map((b) => ctx.backups.toDto(b)),
      policies: ctx.backups.listPolicies(row.id).map((p) => ctx.backups.policyToDto(p)),
    };
  });

  r.post(
    '/api/servers/:id/backups',
    { config: { role: 'operator' }, schema: { params: idParams, body: createBackupSchema } },
    async (request) => {
      const user = requireUser(request);
      const { row, peer } = session(request.params.id);
      ensureIdle(row);
      const taskId = ulid(ctx.now());
      const backupId = ulid(ctx.now());
      const task = ctx.tasks.create({
        id: taskId,
        kind: 'backup.create',
        machineId: row.machineId,
        serverId: row.id,
        refId: backupId,
        createdBy: user.id,
        request: { backupId, comment: request.body.comment },
      });
      const backup = ctx.backups.start({
        id: backupId,
        serverId: row.id,
        machineId: row.machineId,
        kind: 'manual',
        taskId,
        createdBy: user.id,
        ...(request.body.comment === undefined ? {} : { comment: request.body.comment }),
      });
      try {
        await peer.request(
          'backup.create',
          {
            taskId,
            serverId: row.id,
            backupId,
            kind: 'manual',
            ...(ctx.backups.defaultDestination() === undefined
              ? {}
              : { destination: ctx.backups.defaultDestination() }),
            ...(request.body.comment === undefined ? {} : { comment: request.body.comment }),
          },
          { userId: user.id },
        );
      } catch (error) {
        const err = AppError.from(error);
        ctx.tasks.fail(taskId, err.toJSON());
        ctx.backups.fail(backupId, err.message);
        throw err;
      }
      ctx.tasks.markRunning(taskId);
      ctx.audit.record({
        ...auditMeta(request),
        action: 'backup.create',
        targetType: 'server',
        targetId: row.id,
        targetLabel: row.name,
        details: { backupId, taskId },
      });
      return {
        task: ctx.tasks.toDto(ctx.tasks.require(task.id)),
        backup: ctx.backups.toDto(ctx.backups.require(backup.id)),
      };
    },
  );

  r.post(
    '/api/servers/:id/backups/:backupId/restore',
    { config: { role: 'operator' }, schema: { params: backupParams, body: restoreBackupSchema } },
    async (request) => {
      const user = requireUser(request);
      const { row, peer } = session(request.params.id);
      const backup = ctx.backups.require(request.params.backupId);
      if (backup.serverId !== row.id) throw conflict('backup belongs to another server');
      if (backup.status !== 'success')
        throw conflict('backup is not restorable', { status: backup.status });
      ensureIdle(row);
      const taskId = ulid(ctx.now());
      const safetyBackupId = ulid(ctx.now());
      const task = ctx.tasks.create({
        id: taskId,
        kind: 'backup.restore',
        machineId: row.machineId,
        serverId: row.id,
        refId: backup.id,
        createdBy: user.id,
        request: { backupId: backup.id, ...request.body, safetyBackupId },
      });
      if (request.body.safetyBackup) {
        ctx.backups.start({
          id: safetyBackupId,
          serverId: row.id,
          machineId: row.machineId,
          kind: 'pre_restore',
          taskId,
          createdBy: user.id,
          comment: `before restore of ${backup.id}`,
        });
      }
      try {
        await peer.request(
          'backup.restore',
          {
            taskId,
            serverId: row.id,
            backupId: backup.id,
            ...(backup.archivePath === null ? {} : { archivePath: backup.archivePath }),
            safetyBackup: request.body.safetyBackup,
            safetyBackupId,
            restartAfter: request.body.restartAfter,
          },
          { userId: user.id },
        );
      } catch (error) {
        const err = AppError.from(error);
        ctx.tasks.fail(taskId, err.toJSON());
        if (request.body.safetyBackup) ctx.backups.fail(safetyBackupId, err.message);
        throw err;
      }
      ctx.tasks.markRunning(taskId);
      ctx.audit.record({
        ...auditMeta(request),
        action: 'backup.restore',
        targetType: 'server',
        targetId: row.id,
        targetLabel: row.name,
        details: { backupId: backup.id, taskId, ...request.body },
      });
      return { task: ctx.tasks.toDto(ctx.tasks.require(task.id)) };
    },
  );

  // --- Lot 4 : restauration partielle ---------------------------------------------------------

  /**
   * Contenu d'une archive, lu par l'agent sans extraction (`backup.browse`). Lecture seule, donc
   * ouverte à qui voit l'onglet. Un agent N-1 répond `E_UNSUPPORTED_TYPE` (501) : l'UI dit de le
   * mettre à jour.
   */
  r.get(
    '/api/servers/:id/backups/:backupId/browse',
    { schema: { params: backupParams } },
    async (request) => {
      const { row, peer } = session(request.params.id);
      const backup = ctx.backups.require(request.params.backupId);
      if (backup.serverId !== row.id) throw conflict('backup belongs to another server');
      if (backup.status !== 'success')
        throw conflict('backup is not restorable', { status: backup.status });
      return peer.request('backup.browse', {
        serverId: row.id,
        backupId: backup.id,
        ...(backup.archivePath === null ? {} : { archivePath: backup.archivePath }),
      });
    },
  );

  r.post(
    '/api/servers/:id/backups/:backupId/restore-paths',
    { config: { role: 'operator' }, schema: { params: backupParams, body: restorePathsSchema } },
    async (request) => {
      const user = requireUser(request);
      const { row, peer } = session(request.params.id);
      const backup = ctx.backups.require(request.params.backupId);
      if (backup.serverId !== row.id) throw conflict('backup belongs to another server');
      if (backup.status !== 'success')
        throw conflict('backup is not restorable', { status: backup.status });
      ensureIdle(row);
      const { mode, paths } = request.body;
      // Côte à côte, rien n'est remplacé ni arrêté : ni sauvegarde de sécurité, ni relance.
      const safetyBackup = mode === 'in_place' && request.body.safetyBackup;
      const restartAfter = mode === 'in_place' && request.body.restartAfter;
      const taskId = ulid(ctx.now());
      const safetyBackupId = ulid(ctx.now());
      const task = ctx.tasks.create({
        id: taskId,
        kind: 'backup.restorePaths',
        machineId: row.machineId,
        serverId: row.id,
        refId: backup.id,
        createdBy: user.id,
        request: { backupId: backup.id, paths, mode, safetyBackup, restartAfter, safetyBackupId },
      });
      if (safetyBackup) {
        ctx.backups.start({
          id: safetyBackupId,
          serverId: row.id,
          machineId: row.machineId,
          kind: 'pre_restore',
          taskId,
          createdBy: user.id,
          comment: `before partial restore of ${backup.id}`,
        });
      }
      try {
        await peer.request(
          'backup.restorePaths',
          {
            taskId,
            serverId: row.id,
            backupId: backup.id,
            ...(backup.archivePath === null ? {} : { archivePath: backup.archivePath }),
            paths,
            mode,
            safetyBackup,
            safetyBackupId,
            restartAfter,
          },
          { userId: user.id },
        );
      } catch (error) {
        const err = AppError.from(error);
        ctx.tasks.fail(taskId, err.toJSON());
        if (safetyBackup) ctx.backups.fail(safetyBackupId, err.message);
        throw err;
      }
      ctx.tasks.markRunning(taskId);
      ctx.audit.record({
        ...auditMeta(request),
        action: 'backup.restorePaths',
        targetType: 'server',
        targetId: row.id,
        targetLabel: row.name,
        details: {
          backupId: backup.id,
          taskId,
          mode,
          safetyBackup,
          restartAfter,
          pathCount: paths.length,
          paths: paths.slice(0, 20),
        },
      });
      return { task: ctx.tasks.toDto(ctx.tasks.require(task.id)) };
    },
  );

  r.delete(
    '/api/servers/:id/backups/:backupId',
    { config: { role: 'operator' }, schema: { params: backupParams } },
    async (request) => {
      const { row, peer } = session(request.params.id);
      const backup = ctx.backups.require(request.params.backupId);
      if (backup.serverId !== row.id) throw conflict('backup belongs to another server');
      const res = await peer.request('backup.delete', {
        serverId: row.id,
        backupId: backup.id,
        ...(backup.archivePath === null ? {} : { archivePath: backup.archivePath }),
      });
      ctx.backups.markDeleted([backup.id]);
      ctx.audit.record({
        ...auditMeta(request),
        action: 'backup.delete',
        targetType: 'server',
        targetId: row.id,
        targetLabel: row.name,
        details: { backupId: backup.id, deletedOnDisk: res.deleted },
      });
      return { deleted: res.deleted, backup: ctx.backups.toDto(ctx.backups.require(backup.id)) };
    },
  );

  r.get(
    '/api/servers/:id/backups/:backupId/download',
    { schema: { params: backupParams } },
    async (request, reply) => {
      const row = ctx.servers.require(request.params.id);
      const backup = ctx.backups.require(request.params.backupId);
      if (backup.serverId !== row.id || backup.status !== 'success') {
        throw new AppError('E_NOT_FOUND', 'backup not available');
      }
      const handle = await ctx.transfers.download(row.machineId, {
        serverId: row.id,
        backupId: backup.id,
      });
      return sendDownload(reply, handle, backup.sizeBytes ?? handle.size);
    },
  );

  // --- Politiques de backups (exécutées par l'agent) -----------------------------------------

  r.post(
    '/api/servers/:id/backup-policies',
    { config: { role: 'operator' }, schema: { params: idParams, body: backupPolicyInputSchema } },
    async (request) => {
      const row = ctx.servers.require(request.params.id);
      const policy = ctx.backups.createPolicy(row.id, request.body);
      ctx.audit.record({
        ...auditMeta(request),
        action: 'backupPolicy.create',
        targetType: 'server',
        targetId: row.id,
        targetLabel: row.name,
        details: { policyId: policy.id, cron: policy.cron },
      });
      await ctx.registry.get(row.machineId)?.pushConfig();
      return { policy: ctx.backups.policyToDto(policy) };
    },
  );

  r.put(
    '/api/servers/:id/backup-policies/:policyId',
    {
      config: { role: 'operator' },
      schema: { params: policyParams, body: backupPolicyInputSchema.partial() },
    },
    async (request) => {
      const row = ctx.servers.require(request.params.id);
      const existing = ctx.backups.requirePolicy(request.params.policyId);
      if (existing.serverId !== row.id) throw conflict('policy belongs to another server');
      const policy = ctx.backups.updatePolicy(existing.id, request.body);
      ctx.audit.record({
        ...auditMeta(request),
        action: 'backupPolicy.update',
        targetType: 'server',
        targetId: row.id,
        targetLabel: row.name,
        details: { policyId: policy.id, ...request.body },
      });
      await ctx.registry.get(row.machineId)?.pushConfig();
      return { policy: ctx.backups.policyToDto(policy) };
    },
  );

  r.delete(
    '/api/servers/:id/backup-policies/:policyId',
    { config: { role: 'operator' }, schema: { params: policyParams } },
    async (request) => {
      const row = ctx.servers.require(request.params.id);
      const existing = ctx.backups.requirePolicy(request.params.policyId);
      if (existing.serverId !== row.id) throw conflict('policy belongs to another server');
      ctx.backups.deletePolicy(existing.id);
      ctx.audit.record({
        ...auditMeta(request),
        action: 'backupPolicy.delete',
        targetType: 'server',
        targetId: row.id,
        targetLabel: row.name,
        details: { policyId: existing.id },
      });
      await ctx.registry.get(row.machineId)?.pushConfig();
      return { ok: true };
    },
  );

  // --- Planificateur du panel ----------------------------------------------------------------

  r.get('/api/schedules', () => ({
    schedules: ctx.scheduler.list().map((s) => ctx.scheduler.toDto(s)),
  }));

  r.get('/api/servers/:id/schedules', { schema: { params: idParams } }, (request) => {
    const row = ctx.servers.require(request.params.id);
    return { schedules: ctx.scheduler.list(row.id).map((s) => ctx.scheduler.toDto(s)) };
  });

  r.post(
    '/api/servers/:id/schedules',
    { config: { role: 'operator' }, schema: { params: idParams, body: scheduledTaskInputSchema } },
    (request) => {
      const user = requireUser(request);
      const row = ctx.servers.require(request.params.id);
      const schedule = ctx.scheduler.create(row.id, request.body, user.id);
      ctx.audit.record({
        ...auditMeta(request),
        action: 'schedule.create',
        targetType: 'server',
        targetId: row.id,
        targetLabel: row.name,
        details: {
          scheduleId: schedule.id,
          action: schedule.action,
          cron: schedule.cron,
          runAt: schedule.runAt,
        },
      });
      return { schedule: ctx.scheduler.toDto(schedule) };
    },
  );

  r.put(
    '/api/servers/:id/schedules/:scheduleId',
    {
      config: { role: 'operator' },
      schema: { params: scheduleParams, body: scheduledTaskInputSchema.partial() },
    },
    (request) => {
      const row = ctx.servers.require(request.params.id);
      const existing = ctx.scheduler.require(request.params.scheduleId);
      if (existing.serverId !== row.id) throw conflict('schedule belongs to another server');
      const schedule = ctx.scheduler.update(existing.id, request.body);
      ctx.audit.record({
        ...auditMeta(request),
        action: 'schedule.update',
        targetType: 'server',
        targetId: row.id,
        targetLabel: row.name,
        details: { scheduleId: schedule.id, ...request.body },
      });
      return { schedule: ctx.scheduler.toDto(schedule) };
    },
  );

  r.delete(
    '/api/servers/:id/schedules/:scheduleId',
    { config: { role: 'operator' }, schema: { params: scheduleParams } },
    (request) => {
      const row = ctx.servers.require(request.params.id);
      const existing = ctx.scheduler.require(request.params.scheduleId);
      if (existing.serverId !== row.id) throw conflict('schedule belongs to another server');
      ctx.scheduler.delete(existing.id);
      ctx.audit.record({
        ...auditMeta(request),
        action: 'schedule.delete',
        targetType: 'server',
        targetId: row.id,
        targetLabel: row.name,
        details: { scheduleId: existing.id },
      });
      return { ok: true };
    },
  );

  // --- Transferts de l'explorateur -----------------------------------------------------------

  r.get(
    '/api/servers/:id/files/download',
    { schema: { params: idParams, querystring: fsPathQuerySchema } },
    async (request, reply) => {
      const row = ctx.servers.require(request.params.id);
      const handle = await ctx.transfers.download(row.machineId, {
        serverId: row.id,
        path: request.query.path,
      });
      return sendDownload(reply, handle, handle.size);
    },
  );

  app.addContentTypeParser('application/octet-stream', (_request, payload, done) => {
    done(null, payload);
  });

  r.put(
    '/api/servers/:id/files/upload',
    {
      config: { role: 'operator' },
      schema: { params: idParams, querystring: uploadQuerySchema },
      bodyLimit: 64 * 1024 * 1024 * 1024,
    },
    async (request) => {
      const user = requireUser(request);
      const row = ctx.servers.require(request.params.id);
      const body = request.body as AsyncIterable<Uint8Array> | undefined;
      if (body === undefined || typeof body[Symbol.asyncIterator] !== 'function') {
        throw new AppError('E_VALIDATION', 'binary body expected (application/octet-stream)');
      }
      const result = await ctx.transfers.upload(
        row.machineId,
        {
          serverId: row.id,
          path: request.query.path,
          size: request.query.size,
          overwrite: request.query.overwrite ?? false,
        },
        body,
      );
      ctx.audit.record({
        ...auditMeta(request),
        action: 'server.fileUploaded',
        targetType: 'server',
        targetId: row.id,
        targetLabel: row.name,
        details: { path: request.query.path, size: result.size, sha256: result.sha256 },
      });
      ctx.events.publish({
        type: 'server.fileChanged',
        machineId: row.machineId,
        serverId: row.id,
        userId: user.id,
        payload: { path: request.query.path, operation: 'upload', size: result.size },
      });
      return result;
    },
  );

  // --- spark en un clic (jamais requis) ------------------------------------------------------

  const sparkPlatform = (row: ServerRow): string | undefined => SPARK_PLATFORMS[row.loader];
  const sparkStatus = async (row: ServerRow): Promise<SparkStatus> => {
    const platform = sparkPlatform(row);
    if (platform === undefined) {
      return { supported: false, installed: false, file: null, platform: null };
    }
    const session = ctx.registry.get(row.machineId);
    if (!session) return { supported: true, installed: false, file: null, platform };
    const { entries } = await session.peer.request('fs.list', { serverId: row.id, path: 'mods' });
    const file = entries.find((e) => e.kind === 'file' && /^spark-.*\.jar$/i.test(e.name));
    return { supported: true, installed: file !== undefined, file: file?.name ?? null, platform };
  };

  r.get('/api/servers/:id/spark', { schema: { params: idParams } }, async (request) => {
    const row = ctx.servers.require(request.params.id);
    return sparkStatus(row).catch(() => ({
      supported: sparkPlatform(row) !== undefined,
      installed: false,
      file: null,
      platform: sparkPlatform(row) ?? null,
    }));
  });

  r.post(
    '/api/servers/:id/spark/install',
    { config: { role: 'operator' }, schema: { params: idParams } },
    async (request) => {
      const user = requireUser(request);
      const { row, peer } = session(request.params.id);
      const status = await sparkStatus(row);
      if (!status.supported || status.platform === null) {
        throw conflict('spark is not available for this loader', { loader: row.loader });
      }
      if (status.installed) throw conflict('spark already installed', { file: status.file });
      const download = await resolveSparkDownload(status.platform, ctx.fetchImpl);
      const taskId = ulid(ctx.now());
      const target = `mods/${download.fileName}`;
      ctx.tasks.create({
        id: taskId,
        kind: 'fs.fetch',
        machineId: row.machineId,
        serverId: row.id,
        createdBy: user.id,
        request: { path: target, url: download.url },
      });
      try {
        await peer.request(
          'fs.fetch',
          {
            taskId,
            serverId: row.id,
            path: target,
            url: download.url,
            ...(download.sha1 === undefined ? {} : { sha1: download.sha1 }),
            overwrite: false,
          },
          { userId: user.id },
        );
      } catch (error) {
        const err = AppError.from(error);
        ctx.tasks.fail(taskId, err.toJSON());
        throw err;
      }
      ctx.tasks.markRunning(taskId);
      ctx.audit.record({
        ...auditMeta(request),
        action: 'spark.install',
        targetType: 'server',
        targetId: row.id,
        targetLabel: row.name,
        details: { taskId, url: download.url, file: download.fileName },
      });
      return { task: ctx.tasks.toDto(ctx.tasks.require(taskId)) };
    },
  );

  // --- Sauvegarde du panel (VACUUM INTO) -----------------------------------------------------

  r.get('/api/admin/backups', { config: { role: 'admin' } }, () => ({
    backups: ctx.panelBackup.list(),
    directory: ctx.panelBackup.directory,
    status: ctx.panelBackup.status(),
  }));

  r.post('/api/admin/backups', { config: { role: 'admin' } }, async (request) => {
    const backup = await ctx.panelBackup.backupNow();
    ctx.audit.record({
      ...auditMeta(request),
      action: 'panel.backup',
      targetType: 'panel',
      details: backup,
    });
    return { backup };
  });

  /**
   * Lot 4 — téléchargement d'une archive du panel (admin, audité) : elle contient les secrets du
   * panel (secrets des agents, clés de session, jeton DNS, clé privée TLS), l'UI le dit avant.
   * Seul un nom de copie **connue** est servi : `resolveFile` refuse tout autre nom.
   */
  r.get(
    '/api/admin/backups/:file/download',
    { config: { role: 'admin' }, schema: { params: z.object({ file: z.string().min(1) }) } },
    (request, reply) => {
      const file = ctx.panelBackup.resolveFile(request.params.file);
      if (file === undefined) throw notFound('panel backup', request.params.file);
      const size = statSync(file).size;
      ctx.audit.record({
        ...auditMeta(request),
        action: 'panel.backupDownload',
        targetType: 'panel',
        details: { file: request.params.file, sizeBytes: size },
      });
      return sendDownload(
        reply,
        { stream: createReadStream(file), fileName: request.params.file, size },
        size,
      );
    },
  );
}

function sendDownload(
  reply: { header(name: string, value: string): unknown; send(stream: unknown): unknown },
  handle: { stream: NodeJS.ReadableStream; fileName: string; size: number },
  size: number,
) {
  reply.header('content-type', 'application/octet-stream');
  reply.header('content-length', String(size));
  reply.header(
    'content-disposition',
    `attachment; filename="${handle.fileName.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(handle.fileName)}`,
  );
  reply.header('cache-control', 'no-store');
  return reply.send(handle.stream);
}

interface SparkDownload {
  url: string;
  fileName: string;
  sha1?: string | undefined;
}

/**
 * Résout l'URL du jar spark pour une plateforme via l'API publique de spark (`sparkapi.lucko.me`).
 * Réponse attendue : `{ <platform>: { url, sha1? } }` — tout écart produit une erreur honnête.
 */
async function resolveSparkDownload(
  platform: string,
  fetchImpl: typeof fetch | undefined,
): Promise<SparkDownload> {
  const doFetch = fetchImpl ?? fetch;
  let json: unknown;
  try {
    const res = await doFetch(SPARK_API, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
    json = await res.json();
  } catch (error) {
    throw new AppError(
      'E_IO',
      `spark download API unreachable: ${error instanceof Error ? error.message : String(error)}`,
      {
        retryable: true,
        details: { url: SPARK_API },
      },
    );
  }
  const entry = (json as Record<string, { url?: unknown; sha1?: unknown } | undefined> | null)?.[
    platform
  ];
  if (typeof entry?.url !== 'string' || !entry.url.startsWith('https://')) {
    throw new AppError('E_IO', 'spark download API: no jar for this platform', {
      details: { platform },
    });
  }
  const fileName = decodeURIComponent(entry.url.split('/').pop() ?? '') || `spark-${platform}.jar`;
  return {
    url: entry.url,
    fileName: /\.jar$/i.test(fileName) ? fileName : `spark-${platform}.jar`,
    sha1:
      typeof entry.sha1 === 'string' && /^[0-9a-f]{40}$/i.test(entry.sha1) ? entry.sha1 : undefined,
  };
}
