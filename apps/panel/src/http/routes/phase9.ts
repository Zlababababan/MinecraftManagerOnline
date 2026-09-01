/**
 * Phase 9 — migrations de serveurs (pré-checks, lancement, suivi), Java géré par machine
 * (inventaire, `java.install` multi-fournisseur / relais, suppression), releases d'agent (publication
 * d'un bundle signé, mise à jour poussée, `runtime.update`), et **relais** `/api/relay/:token` : URL
 * sans session servie aux agents (bundle, JRE en cache, archive de migration relayée depuis l'agent
 * source) avec reprise `Range`.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import {
  duplicatePrecheckRequestSchema,
  duplicateServerSchema,
  installJavaSchema,
  migrationPrecheckRequestSchema,
  publishReleaseQuerySchema,
  startMigrationSchema,
  updateAgentSchema,
  type MachineDto,
} from '@mmo/protocol/client';

import type { AppContext } from '../../context.js';
import { AppError, notFound } from '../../errors.js';
import { requireUser } from '../auth.js';
import { auditMeta } from './setup-auth.js';

const idParams = z.object({ id: z.string().min(1) });
const runtimeParams = z.object({ id: z.string().min(1), runtimeId: z.string().min(1) });
const versionParams = z.object({ version: z.string().min(1) });
const tokenParams = z.object({ token: z.string().regex(/^[0-9a-f]{32}$/) });

const runtimeUpdateBodySchema = z.object({
  version: z.string().min(1),
  url: z.url(),
  sha256: z.string().length(64),
  archive: z.enum(['zip', 'tar.gz']),
  size: z.int().nonnegative().optional(),
});

/** Champs phase 9 du DTO machine (runtime, dernière release, mise à jour disponible). */
export function machineUpdateFields(
  ctx: AppContext,
  row: { agentVersion: string | null; runtimeVersion: string | null },
): Pick<MachineDto, 'runtimeVersion' | 'latestRelease' | 'updateAvailable'> {
  const latest = ctx.releases.latest();
  return {
    runtimeVersion: row.runtimeVersion,
    latestRelease: latest?.version ?? null,
    updateAvailable: ctx.releases.updateAvailable(row.agentVersion) !== undefined,
  };
}

export function registerPhase9Routes(app: FastifyInstance, ctx: AppContext): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // --- Migrations ---------------------------------------------------------------------------------

  r.get('/api/servers/:id/migrations', { schema: { params: idParams } }, (request) => {
    const row = ctx.servers.require(request.params.id);
    return { migrations: ctx.migrations.listForServer(row.id).map((m) => ctx.migrations.toDto(m)) };
  });

  r.get('/api/migrations/:id', { schema: { params: idParams } }, (request) => ({
    migration: ctx.migrations.toDto(ctx.migrations.require(request.params.id)),
  }));

  r.post(
    '/api/servers/:id/migrations/precheck',
    {
      config: { role: 'operator' },
      schema: { params: idParams, body: migrationPrecheckRequestSchema },
    },
    async (request) => ({
      precheck: await ctx.migrations.precheck(request.params.id, request.body),
    }),
  );

  r.post(
    '/api/servers/:id/migrations',
    { config: { role: 'admin' }, schema: { params: idParams, body: startMigrationSchema } },
    async (request, reply) => {
      const user = requireUser(request);
      const row = await ctx.migrations.start(request.params.id, request.body, user.id);
      return reply.code(202).send({ migration: ctx.migrations.toDto(row) });
    },
  );

  // --- Duplication (même chaîne, nouvel identifiant, la source reste en place) --------------------

  r.post(
    '/api/servers/:id/duplicate/precheck',
    {
      config: { role: 'operator' },
      schema: { params: idParams, body: duplicatePrecheckRequestSchema },
    },
    async (request) => {
      ctx.servers.require(request.params.id);
      return { precheck: await ctx.migrations.duplicatePrecheck(request.params.id, request.body) };
    },
  );

  r.post(
    '/api/servers/:id/duplicate',
    { config: { role: 'admin' }, schema: { params: idParams, body: duplicateServerSchema } },
    async (request, reply) => {
      const user = requireUser(request);
      const row = await ctx.migrations.startDuplicate(request.params.id, request.body, user.id);
      return reply.code(202).send({ migration: ctx.migrations.toDto(row) });
    },
  );

  // --- Java géré ----------------------------------------------------------------------------------

  r.get('/api/machines/:id/java', { schema: { params: idParams } }, async (request) => {
    const machine = ctx.machines.require(request.params.id);
    const rows = await ctx.javaRuntimes.refresh(machine.id);
    return { runtimes: rows.map((row) => ctx.javaRuntimes.toDto(row)) };
  });

  r.post(
    '/api/machines/:id/java/install',
    { config: { role: 'admin' }, schema: { params: idParams, body: installJavaSchema } },
    async (request, reply) => {
      const user = requireUser(request);
      const machine = ctx.machines.require(request.params.id);
      const { taskId, sources } = await ctx.javaRuntimes.install(machine, request.body, user.id);
      ctx.audit.record({
        ...auditMeta(request),
        action: 'java.install',
        targetType: 'machine',
        targetId: machine.id,
        targetLabel: machine.name,
        details: {
          majorVersion: request.body.majorVersion,
          relay: request.body.relay,
          sources: sources.map((s) => `${s.vendor}${s.emulated ? ' (x64)' : ''}`),
        },
      });
      return reply.code(202).send({
        task: ctx.tasks.toDto(ctx.tasks.require(taskId)),
        sources: sources.map((s) => ({
          vendor: s.vendor,
          emulated: s.emulated,
          relay: s.relay,
          fullVersion: s.fullVersion ?? null,
        })),
      });
    },
  );

  r.delete(
    '/api/machines/:id/java/:runtimeId',
    { config: { role: 'admin' }, schema: { params: runtimeParams } },
    async (request, reply) => {
      const machine = ctx.machines.require(request.params.id);
      const runtime = ctx.javaRuntimes.get(request.params.runtimeId);
      await ctx.javaRuntimes.remove(machine.id, request.params.runtimeId);
      ctx.audit.record({
        ...auditMeta(request),
        action: 'java.remove',
        targetType: 'machine',
        targetId: machine.id,
        targetLabel: machine.name,
        details: { path: runtime?.path ?? null, majorVersion: runtime?.majorVersion ?? null },
      });
      return reply.code(204).send();
    },
  );

  // --- Releases d'agent et mises à jour ------------------------------------------------------------

  r.get('/api/agent-releases', () => ({
    releases: ctx.releases.list().map((row) => ctx.releases.toDto(row)),
    latest: ctx.releases.latest()?.version ?? null,
  }));

  r.put(
    '/api/admin/agent-releases',
    {
      config: { role: 'admin' },
      schema: { querystring: publishReleaseQuerySchema },
      bodyLimit: 64 * 1024 * 1024,
    },
    async (request, reply) => {
      const body = request.body as Readable | undefined;
      if (body === undefined || typeof (body as { pipe?: unknown }).pipe !== 'function') {
        throw new AppError('E_VALIDATION', 'binary body expected (application/octet-stream)');
      }
      const release = await ctx.releases.publish(request.query, body);
      ctx.audit.record({
        ...auditMeta(request),
        action: 'agentRelease.published',
        targetType: 'release',
        targetId: release.version,
        details: {
          sha256: release.bundleSha256,
          size: release.bundleSize,
          channel: release.channel,
        },
      });
      return reply.code(201).send({ release: ctx.releases.toDto(release) });
    },
  );

  r.delete(
    '/api/admin/agent-releases/:version',
    { config: { role: 'admin' }, schema: { params: versionParams } },
    async (request, reply) => {
      await ctx.releases.delete(request.params.version);
      ctx.audit.record({
        ...auditMeta(request),
        action: 'agentRelease.deleted',
        targetType: 'release',
        targetId: request.params.version,
      });
      return reply.code(204).send();
    },
  );

  r.post(
    '/api/machines/:id/update',
    { config: { role: 'admin' }, schema: { params: idParams, body: updateAgentSchema } },
    async (request) => {
      const user = requireUser(request);
      const machine = ctx.machines.require(request.params.id);
      const result = await ctx.releases.pushUpdate(machine.id, request.body.version, user.id);
      ctx.audit.record({
        ...auditMeta(request),
        action: 'machine.updatePushed',
        targetType: 'machine',
        targetId: machine.id,
        targetLabel: machine.name,
        details: result,
      });
      return result;
    },
  );

  r.post(
    '/api/machines/:id/runtime-update',
    { config: { role: 'admin' }, schema: { params: idParams, body: runtimeUpdateBodySchema } },
    async (request) => {
      const user = requireUser(request);
      const machine = ctx.machines.require(request.params.id);
      if (machine.os === null || machine.arch === null) {
        throw new AppError('E_CONFLICT', 'machine platform unknown');
      }
      const session = ctx.registry.require(machine.id);
      const res = await session.peer.request(
        'runtime.update',
        { ...request.body, os: machine.os, arch: machine.arch },
        { userId: user.id },
      );
      ctx.audit.record({
        ...auditMeta(request),
        action: 'machine.runtimeUpdatePushed',
        targetType: 'machine',
        targetId: machine.id,
        targetLabel: machine.name,
        details: { version: request.body.version, pending: res.pending },
      });
      return res;
    },
  );

  // --- Relais (sans session : jeton à durée de vie courte) -----------------------------------------

  r.route({
    method: ['GET', 'HEAD'],
    url: '/api/relay/:token',
    config: { public: true },
    schema: { params: tokenParams },
    handler: async (request, reply) => {
      const payload = ctx.relayTokens.get(request.params.token);
      if (!payload) throw notFound('relay token');
      const range = parseRange(request.headers.range, payload.size);
      if (range === 'invalid') {
        return reply
          .code(416)
          .header('content-range', `bytes */${String(payload.size)}`)
          .send();
      }
      const start = range?.start ?? 0;
      const end = range?.end ?? payload.size - 1;
      reply.header('content-type', 'application/octet-stream');
      reply.header('accept-ranges', 'bytes');
      reply.header('cache-control', 'no-store');
      reply.header('content-disposition', `attachment; filename="${payload.fileName}"`);
      reply.header('content-length', String(payload.size === 0 ? 0 : end - start + 1));
      if (range) {
        reply.code(206);
        reply.header(
          'content-range',
          `bytes ${String(start)}-${String(end)}/${String(payload.size)}`,
        );
      }
      if (request.method === 'HEAD' || payload.size === 0) return reply.send();
      if (payload.kind === 'migration') {
        // Archive relayée depuis l'agent source (WS → HTTP), reprise par offset.
        const handle = await ctx.transfers.download(
          payload.machineId,
          { serverId: payload.serverId, backupId: payload.backupId },
          { offset: start },
        );
        return reply.send(handle.stream);
      }
      return sendFileRange(reply, payload.file, start, end);
    },
  });
}

function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | undefined | 'invalid' {
  if (header === undefined) return undefined;
  const m = /^bytes=(\d+)-(\d*)$/.exec(header);
  if (!m) return 'invalid';
  const start = Number(m[1]);
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start >= size && size > 0) return 'invalid';
  return { start, end };
}

async function sendFileRange(
  reply: FastifyReply,
  file: string,
  start: number,
  end: number,
): Promise<FastifyReply> {
  const st = await stat(file).catch(() => undefined);
  if (!st?.isFile()) throw notFound('relay file');
  return reply.send(createReadStream(file, { start, end: Math.min(end, st.size - 1) }));
}
