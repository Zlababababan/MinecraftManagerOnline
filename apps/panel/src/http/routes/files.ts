/**
 * Phase 6 — relais vers l'agent : configuration typée (`config.*`), explorateur de fichiers
 * (`fs.*`, jail + corbeille côté agent), journaux (`logs.*`). Le panel ne stocke rien : les
 * fichiers du serveur restent la source de vérité (doc 04 §4), chaque écriture est auditée et
 * publiée comme événement.
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import {
  configFileParamsSchema,
  configSetRequestSchema,
  fsMoveBodySchema,
  fsPathBodySchema,
  fsPathQuerySchema,
  fsWriteBodySchema,
  logsSearchRequestSchema,
} from '@mmo/protocol/client';

import type { AppContext } from '../../context.js';
import { configChanges, parseKeyValues, textChanges } from '../../util/config-diff.js';
import { requireUser } from '../auth.js';
import { auditMeta } from './setup-auth.js';

const idParams = z.object({ id: z.string().min(1) });

export function registerFileRoutes(app: FastifyInstance, ctx: AppContext): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const session = (serverId: string) => {
    const row = ctx.servers.require(serverId);
    return { row, peer: ctx.registry.require(row.machineId).peer };
  };

  /**
   * Le port affiché (aperçu, carte, adresse des joueurs) est une copie tenue par le panel. Elle
   * suit le fichier dès qu'on l'enregistre — mais seulement serveur arrêté : en marche, Minecraft
   * écoute encore sur l'ancien port jusqu'au redémarrage, et c'est l'agent qui annonce alors le
   * nouveau (rapport d'état au démarrage).
   */
  const refreshGamePort = async (
    row: ReturnType<typeof session>['row'],
    value: unknown,
  ): Promise<void> => {
    const port = typeof value === 'string' || typeof value === 'number' ? Number(value) : NaN;
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return;
    if (row.runState !== 'stopped' || row.gamePort === port) return;
    await ctx.servers.update(row.id, { gamePort: port });
  };

  // --- Configuration typée ----------------------------------------------------------------------

  r.get(
    '/api/servers/:id/config/:file',
    { schema: { params: configFileParamsSchema } },
    async (request) => {
      const { row, peer } = session(request.params.id);
      return peer.request('config.get', { serverId: row.id, file: request.params.file });
    },
  );

  r.put(
    '/api/servers/:id/config/:file',
    {
      config: { role: 'operator' },
      schema: { params: configFileParamsSchema, body: configSetRequestSchema },
    },
    async (request) => {
      const user = requireUser(request);
      const { row, peer } = session(request.params.id);
      const { file } = request.params;
      // Lu AVANT d'écrire : l'audit dit quelle clé a changé, de quelle valeur à quelle valeur.
      const before = await peer
        .request('config.get', { serverId: row.id, file })
        .then((r) => r.data)
        .catch(() => undefined);
      const res = await peer.request(
        'config.set',
        {
          serverId: row.id,
          file,
          data: request.body.data,
          ...(request.body.expectedSha256 === undefined
            ? {}
            : { expectedSha256: request.body.expectedSha256 }),
        },
        { userId: user.id },
      );
      ctx.audit.record({
        ...auditMeta(request),
        action: 'server.configChanged',
        targetType: 'server',
        targetId: row.id,
        targetLabel: row.name,
        details: {
          file,
          applied: res.applied,
          commands: res.commands,
          warnings: res.warnings,
          changes: configChanges(before, request.body.data),
        },
      });
      if (file === 'server.properties') {
        const patch = request.body.data as Record<string, unknown> | null;
        await refreshGamePort(row, patch?.['server-port']);
      }
      ctx.events.publish({
        type: 'server.configChanged',
        machineId: row.machineId,
        serverId: row.id,
        userId: user.id,
        payload: { file, applied: res.applied, restartRequired: res.restartRequired },
      });
      return res;
    },
  );

  // --- Explorateur de fichiers --------------------------------------------------------------------

  r.get(
    '/api/servers/:id/files',
    { schema: { params: idParams, querystring: fsPathQuerySchema } },
    async (request) => {
      const { row, peer } = session(request.params.id);
      const res = await peer.request('fs.list', { serverId: row.id, path: request.query.path });
      return { path: request.query.path, entries: res.entries };
    },
  );

  r.get(
    '/api/servers/:id/files/stat',
    { schema: { params: idParams, querystring: fsPathQuerySchema } },
    async (request) => {
      const { row, peer } = session(request.params.id);
      return peer.request('fs.stat', { serverId: row.id, path: request.query.path });
    },
  );

  r.get(
    '/api/servers/:id/files/read',
    {
      schema: {
        params: idParams,
        querystring: fsPathQuerySchema.extend({
          maxBytes: z.coerce.number().int().positive().optional(),
        }),
      },
    },
    async (request) => {
      const { row, peer } = session(request.params.id);
      return peer.request('fs.read', {
        serverId: row.id,
        path: request.query.path,
        ...(request.query.maxBytes === undefined ? {} : { maxBytes: request.query.maxBytes }),
      });
    },
  );

  const mutation = <T>(
    name: string,
    action: string,
    run: (serverId: string, peer: ReturnType<typeof session>['peer']) => Promise<T>,
    body: unknown,
    request: Parameters<typeof requireUser>[0],
    serverId: string,
  ): Promise<T> => {
    const user = requireUser(request);
    const { row, peer } = session(serverId);
    return run(row.id, peer).then((res) => {
      ctx.audit.record({
        ...auditMeta(request),
        action,
        targetType: 'server',
        targetId: row.id,
        targetLabel: row.name,
        details: body,
      });
      ctx.events.publish({
        type: 'server.fileChanged',
        machineId: row.machineId,
        serverId: row.id,
        userId: user.id,
        payload: { operation: name, ...(typeof body === 'object' && body !== null ? body : {}) },
      });
      return res;
    });
  };

  r.post(
    '/api/servers/:id/files/mkdir',
    { config: { role: 'operator' }, schema: { params: idParams, body: fsPathBodySchema } },
    (request, reply) =>
      mutation(
        'mkdir',
        'server.fileMkdir',
        async (serverId, peer) => {
          await peer.request('fs.mkdir', { serverId, path: request.body.path });
          return reply.code(204).send();
        },
        request.body,
        request,
        request.params.id,
      ),
  );

  r.post(
    '/api/servers/:id/files/rename',
    { config: { role: 'operator' }, schema: { params: idParams, body: fsMoveBodySchema } },
    (request, reply) =>
      mutation(
        'rename',
        'server.fileRename',
        async (serverId, peer) => {
          await peer.request('fs.rename', { serverId, ...request.body });
          return reply.code(204).send();
        },
        request.body,
        request,
        request.params.id,
      ),
  );

  r.post(
    '/api/servers/:id/files/copy',
    { config: { role: 'operator' }, schema: { params: idParams, body: fsMoveBodySchema } },
    (request, reply) =>
      mutation(
        'copy',
        'server.fileCopy',
        async (serverId, peer) => {
          await peer.request('fs.copy', { serverId, ...request.body });
          return reply.code(204).send();
        },
        request.body,
        request,
        request.params.id,
      ),
  );

  /** Suppression = corbeille `.mmo-trash/` côté agent (restaurable par `rename`). */
  r.post(
    '/api/servers/:id/files/delete',
    { config: { role: 'operator' }, schema: { params: idParams, body: fsPathBodySchema } },
    (request) =>
      mutation(
        'delete',
        'server.fileDeleted',
        (serverId, peer) => peer.request('fs.delete', { serverId, path: request.body.path }),
        request.body,
        request,
        request.params.id,
      ),
  );

  r.put(
    '/api/servers/:id/files/write',
    { config: { role: 'operator' }, schema: { params: idParams, body: fsWriteBodySchema } },
    async (request) => {
      const { row, peer } = session(request.params.id);
      const { path, content } = request.body;
      // Lu AVANT d'écrire, pour dire dans l'audit ce qui a changé. Fichier absent ou trop gros
      // pour être lu en entier : on note seulement l'écriture.
      const before = await peer
        .request('fs.read', { serverId: row.id, path })
        .then((r) => (r.truncated ? null : r.content))
        .catch((error: unknown) =>
          (error as { code?: unknown } | null)?.code === 'E_NOT_FOUND' ? undefined : null,
        );
      const res = await mutation(
        'write',
        'server.fileWritten',
        (serverId, p) => p.request('fs.write', { serverId, ...request.body }),
        {
          path,
          bytes: Buffer.byteLength(content, 'utf8'),
          ...(before === null ? {} : { changes: textChanges(path, before, content) }),
        },
        request,
        request.params.id,
      );
      if (path === 'server.properties') {
        await refreshGamePort(row, parseKeyValues(content)['server-port']);
      }
      return res;
    },
  );

  // --- Journaux -----------------------------------------------------------------------------------

  r.get('/api/servers/:id/logs', { schema: { params: idParams } }, async (request) => {
    const { row, peer } = session(request.params.id);
    return peer.request('logs.listFiles', { serverId: row.id });
  });

  r.post(
    '/api/servers/:id/logs/search',
    { schema: { params: idParams, body: logsSearchRequestSchema } },
    async (request) => {
      const { row, peer } = session(request.params.id);
      return peer.request(
        'logs.search',
        { serverId: row.id, ...request.body },
        { deadlineMs: 60_000 },
      );
    },
  );
}
