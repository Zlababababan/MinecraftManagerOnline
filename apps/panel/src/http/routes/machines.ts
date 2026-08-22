/** Machines : appairage, secrets, répertoires surveillés, scan (doc 05 §3, doc 07 phase 4). */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import {
  addDirectorySchema,
  createMachineSchema,
  metricsQuerySchema,
  scanRequestSchema,
  updateMachineSchema,
  type MachineDto,
  type PairingCodeDto,
} from '@mmo/protocol/client';

import type { AppContext } from '../../context.js';
import type { MachineRow } from '../../db/schema.js';
import { SETTING_KEYS } from '../../services/settings.js';
import { requireUser } from '../auth.js';
import { machineUpdateFields } from './phase9.js';
import { auditMeta } from './setup-auth.js';

const idParams = z.object({ id: z.string().min(1) });
const dirParams = z.object({ id: z.string().min(1), dirId: z.string().min(1) });

export function machineDto(ctx: AppContext, row: MachineRow): MachineDto {
  const session = ctx.registry.get(row.id);
  const hb = session?.heartbeat;
  return {
    id: row.id,
    name: row.name,
    os: row.os,
    arch: row.arch,
    hostname: row.hostname,
    agentVersion: row.agentVersion,
    protocolVersion: row.protocolVersion,
    status: row.status,
    connected: session !== undefined,
    lastSeenAt: row.lastSeenAt,
    cpuModel: row.cpuModel,
    cpuCores: row.cpuCores,
    ramTotalMb: row.ramTotalMb,
    createdAt: row.createdAt,
    ...machineUpdateFields(ctx, row),
    ...(hb === undefined
      ? {}
      : {
          heartbeat: {
            ts: hb.ts,
            ...(hb.cpuPct === undefined ? {} : { cpuPct: hb.cpuPct }),
            ...(hb.cpuSource === undefined ? {} : { cpuSource: hb.cpuSource }),
            ...(hb.ramUsedMb === undefined ? {} : { ramUsedMb: hb.ramUsedMb }),
            ...(hb.ramTotalMb === undefined ? {} : { ramTotalMb: hb.ramTotalMb }),
            ...(hb.diskUsedGb === undefined ? {} : { diskUsedGb: hb.diskUsedGb }),
            ...(hb.diskTotalGb === undefined ? {} : { diskTotalGb: hb.diskTotalGb }),
            activeServers: hb.activeServers,
            activeTasks: hb.activeTasks,
          },
        }),
    watchedDirectories: ctx.machines.directories(row.id).map((d) => ({
      id: d.id,
      path: d.path,
      enabled: d.enabled === 1,
      lastScanAt: d.lastScanAt,
    })),
  };
}

function pairingDto(
  ctx: AppContext,
  machineId: string,
  code: string,
  expiresAt: number,
): PairingCodeDto {
  const publicUrl = ctx.settings.get(SETTING_KEYS.publicUrl);
  return {
    machineId,
    code,
    expiresAt,
    ...(publicUrl === undefined
      ? {}
      : {
          install: {
            windows: `& ([scriptblock]::Create((irm ${publicUrl}/install.ps1))) -PairCode ${code}`,
            unix: `curl -fsSL ${publicUrl}/install.sh | sh -s -- --pair-code ${code}`,
          },
        }),
  };
}

export function registerMachineRoutes(app: FastifyInstance, ctx: AppContext): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get('/api/machines', () => ({ machines: ctx.machines.list().map((m) => machineDto(ctx, m)) }));

  r.get('/api/machines/:id', { schema: { params: idParams } }, (request) => ({
    machine: machineDto(ctx, ctx.machines.require(request.params.id)),
  }));

  /** Métriques historiques de la machine (phase 7). */
  r.get(
    '/api/machines/:id/metrics',
    { schema: { params: idParams, querystring: metricsQuerySchema } },
    (request) => {
      const row = ctx.machines.require(request.params.id);
      return ctx.metricsService.queryMachine(row.id, request.query);
    },
  );

  /** « Ajouter machine » : création + premier code d'appairage. */
  r.post(
    '/api/machines',
    { config: { role: 'admin' }, schema: { body: createMachineSchema } },
    (request, reply) => {
      const user = requireUser(request);
      const machine = ctx.machines.create(request.body.name);
      const { code, expiresAt } = ctx.machines.createPairingCode(machine.id, user.id);
      ctx.audit.record({
        ...auditMeta(request),
        action: 'machine.created',
        targetType: 'machine',
        targetId: machine.id,
        targetLabel: machine.name,
      });
      return reply.code(201).send({
        machine: machineDto(ctx, machine),
        pairing: pairingDto(ctx, machine.id, code, expiresAt),
      });
    },
  );

  r.post(
    '/api/machines/:id/pairing-codes',
    { config: { role: 'admin' }, schema: { params: idParams } },
    (request, reply) => {
      const user = requireUser(request);
      const machine = ctx.machines.require(request.params.id);
      const { code, expiresAt } = ctx.machines.createPairingCode(machine.id, user.id);
      ctx.audit.record({
        ...auditMeta(request),
        action: 'machine.pairingCodeCreated',
        targetType: 'machine',
        targetId: machine.id,
        targetLabel: machine.name,
      });
      return reply.code(201).send({ pairing: pairingDto(ctx, machine.id, code, expiresAt) });
    },
  );

  r.patch(
    '/api/machines/:id',
    { config: { role: 'admin' }, schema: { params: idParams, body: updateMachineSchema } },
    (request) => {
      const machine = ctx.machines.update(request.params.id, request.body);
      if (request.body.disabled === true)
        ctx.registry.get(machine.id)?.close(4003, 'machine disabled');
      ctx.audit.record({
        ...auditMeta(request),
        action: 'machine.updated',
        targetType: 'machine',
        targetId: machine.id,
        targetLabel: machine.name,
        details: request.body,
      });
      return { machine: machineDto(ctx, machine) };
    },
  );

  /** Révocation : la session est fermée, le secret n'est plus reconnu, les serveurs sont oubliés. */
  r.delete(
    '/api/machines/:id',
    { config: { role: 'admin' }, schema: { params: idParams } },
    (request, reply) => {
      const machine = ctx.machines.require(request.params.id);
      ctx.registry.get(machine.id)?.close(4003, 'machine revoked');
      ctx.machines.delete(machine.id);
      ctx.audit.record({
        ...auditMeta(request),
        action: 'machine.deleted',
        targetType: 'machine',
        targetId: machine.id,
        targetLabel: machine.name,
      });
      return reply.code(204).send();
    },
  );

  /** Rotation du secret (doc 05 §3) : les deux secrets valides 24 h. */
  r.post(
    '/api/machines/:id/rotate-secret',
    { config: { role: 'admin' }, schema: { params: idParams } },
    async (request) => {
      const user = requireUser(request);
      const machine = ctx.machines.require(request.params.id);
      const session = ctx.registry.require(machine.id);
      const { secret, graceUntil } = ctx.machines.beginRotation(machine.id);
      await session.peer.request(
        'agent.rotateSecret',
        { newSecret: secret, graceUntil },
        { userId: user.id },
      );
      ctx.machines.commitRotation(machine.id, secret, graceUntil);
      ctx.audit.record({
        ...auditMeta(request),
        action: 'machine.secretRotated',
        targetType: 'machine',
        targetId: machine.id,
        targetLabel: machine.name,
        details: { graceUntil },
      });
      return { ok: true, graceUntil };
    },
  );

  r.get('/api/machines/:id/info', { schema: { params: idParams } }, async (request) => {
    const user = requireUser(request);
    const machine = ctx.machines.require(request.params.id);
    return ctx.registry.require(machine.id).peer.request('agent.info', {}, { userId: user.id });
  });

  // --- Répertoires surveillés -------------------------------------------------------------------

  r.post(
    '/api/machines/:id/directories',
    { config: { role: 'admin' }, schema: { params: idParams, body: addDirectorySchema } },
    async (request, reply) => {
      const machine = ctx.machines.require(request.params.id);
      const dir = ctx.machines.addDirectory(machine.id, request.body.path);
      ctx.audit.record({
        ...auditMeta(request),
        action: 'machine.directoryAdded',
        targetType: 'machine',
        targetId: machine.id,
        targetLabel: machine.name,
        details: { path: dir.path },
      });
      await ctx.registry.get(machine.id)?.pushConfig();
      return reply
        .code(201)
        .send({ directory: { id: dir.id, path: dir.path, enabled: true, lastScanAt: null } });
    },
  );

  r.delete(
    '/api/machines/:id/directories/:dirId',
    { config: { role: 'admin' }, schema: { params: dirParams } },
    async (request, reply) => {
      const machine = ctx.machines.require(request.params.id);
      ctx.machines.removeDirectory(machine.id, request.params.dirId);
      ctx.audit.record({
        ...auditMeta(request),
        action: 'machine.directoryRemoved',
        targetType: 'machine',
        targetId: machine.id,
        targetLabel: machine.name,
        details: { directoryId: request.params.dirId },
      });
      await ctx.registry.get(machine.id)?.pushConfig();
      return reply.code(204).send();
    },
  );

  /** Scan immédiat (répertoires surveillés + chemins ad hoc) ; les détections sont adoptées. */
  r.post(
    '/api/machines/:id/scan',
    { config: { role: 'operator' }, schema: { params: idParams, body: scanRequestSchema } },
    async (request) => {
      const user = requireUser(request);
      const machine = ctx.machines.require(request.params.id);
      const session = ctx.registry.require(machine.id);
      const res = await session.peer.request(
        'scan.run',
        request.body.paths === undefined ? {} : { paths: request.body.paths },
        { userId: user.id },
      );
      ctx.machines.markScanned(machine.id);
      const adopted: string[] = [];
      for (const detected of res.servers) {
        const result = await ctx.servers.adoptDetected(machine.id, detected, undefined);
        if (result.server) adopted.push(result.server.id);
      }
      await session.pushConfig();
      return {
        scannedPaths: res.scannedPaths,
        servers: adopted.map((id) => ctx.servers.toDto(ctx.servers.require(id), true)),
        conflicts: ctx.servers.listConflicts().filter((c) => c.found.machineId === machine.id),
      };
    },
  );
}
