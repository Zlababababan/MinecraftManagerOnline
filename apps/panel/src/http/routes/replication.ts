/**
 * Lot 4 — réplication hors-site : réglage par serveur (`PUT …/replication`), copie à la demande
 * (`POST …/backups/:backupId/replicate`), rapatriement depuis une copie
 * (`POST …/replicas/:replicaId/pull`) et suppression d'une copie. Le réglage et les copies sont
 * servis avec la liste des sauvegardes (`GET …/backups`, tasks.ts). Rôle opérateur, comme les
 * sauvegardes elles-mêmes.
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { replicationInputSchema } from '@mmo/protocol/client';

import type { AppContext } from '../../context.js';
import { AppError, conflict } from '../../errors.js';
import { requireUser } from '../auth.js';
import { auditMeta } from './setup-auth.js';

const idParams = z.object({ id: z.string().min(1) });
const backupParams = z.object({ id: z.string().min(1), backupId: z.string().min(1) });
const replicaParams = backupParams.extend({ replicaId: z.string().min(1) });
/** Absent = la machine du réglage du serveur. */
const replicateBody = z.object({ machineId: z.string().min(1).optional() });

export function registerReplicationRoutes(app: FastifyInstance, ctx: AppContext): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const backupOf = (serverId: string, backupId: string) => {
    const row = ctx.servers.require(serverId);
    const backup = ctx.backups.require(backupId);
    if (backup.serverId !== row.id) throw conflict('backup belongs to another server');
    return { row, backup };
  };

  r.put(
    '/api/servers/:id/replication',
    { config: { role: 'operator' }, schema: { params: idParams, body: replicationInputSchema } },
    (request) => {
      const row = ctx.servers.require(request.params.id);
      const replication = ctx.replication.setConfig(row.id, request.body);
      ctx.audit.record({
        ...auditMeta(request),
        action: 'backup.replication',
        targetType: 'server',
        targetId: row.id,
        targetLabel: row.name,
        details: request.body,
      });
      // Une destination réglée maintenant reçoit tout de suite la dernière archive saine (si les
      // deux agents sont là) : l'utilisateur n'attend pas la prochaine sauvegarde pour être couvert.
      if (replication?.enabled === true) void ctx.replication.catchUpServer(row.id);
      return { replication };
    },
  );

  r.post(
    '/api/servers/:id/backups/:backupId/replicate',
    { config: { role: 'operator' }, schema: { params: backupParams, body: replicateBody } },
    async (request, reply) => {
      const user = requireUser(request);
      const { row, backup } = backupOf(request.params.id, request.params.backupId);
      const cfg = ctx.replication.config(row.id);
      const machineId = request.body.machineId ?? cfg?.machineId;
      if (machineId === undefined) {
        throw new AppError('E_VALIDATION', 'no off-site machine configured for this server', {
          details: { key: 'machineId', reason: 'NO_DESTINATION' },
        });
      }
      const replica = await ctx.replication.replicate(backup, machineId, {
        keep: cfg?.keepLast,
        userId: user.id,
      });
      ctx.audit.record({
        ...auditMeta(request),
        action: 'backup.replicate',
        targetType: 'server',
        targetId: row.id,
        targetLabel: row.name,
        details: { backupId: backup.id, machineId, replicaId: replica.id },
      });
      return reply.code(202).send({
        replica: ctx.replication.toDto(replica),
        task: replica.taskId === null ? null : ctx.tasks.toDto(ctx.tasks.require(replica.taskId)),
      });
    },
  );

  r.post(
    '/api/servers/:id/backups/:backupId/replicas/:replicaId/pull',
    { config: { role: 'operator' }, schema: { params: replicaParams } },
    async (request, reply) => {
      const user = requireUser(request);
      const { row, backup } = backupOf(request.params.id, request.params.backupId);
      const task = await ctx.replication.pullBack(backup.id, request.params.replicaId, user.id);
      ctx.audit.record({
        ...auditMeta(request),
        action: 'backup.pullBack',
        targetType: 'server',
        targetId: row.id,
        targetLabel: row.name,
        details: { backupId: backup.id, replicaId: request.params.replicaId, taskId: task.id },
      });
      return reply.code(202).send({ task: ctx.tasks.toDto(task) });
    },
  );

  r.delete(
    '/api/servers/:id/backups/:backupId/replicas/:replicaId',
    { config: { role: 'operator' }, schema: { params: replicaParams } },
    async (request) => {
      const { row, backup } = backupOf(request.params.id, request.params.backupId);
      const existing = ctx.replication.require(request.params.replicaId);
      if (existing.backupId !== backup.id) throw conflict('copy belongs to another backup');
      const replica = await ctx.replication.remove(existing.id);
      ctx.audit.record({
        ...auditMeta(request),
        action: 'backup.replicaDelete',
        targetType: 'server',
        targetId: row.id,
        targetLabel: row.name,
        details: { backupId: backup.id, replicaId: replica.id, machineId: replica.machineId },
      });
      return { replica: ctx.replication.toDto(replica) };
    },
  );
}
