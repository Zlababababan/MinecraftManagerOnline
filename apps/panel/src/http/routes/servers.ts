/** Serveurs : lecture, adoption manuelle, réglages, start/stop/restart/kill, console, commandes, joueurs, conflits. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';

import {
  bulkActionSchema,
  commandRequestSchema,
  createServerSchema,
  macroInputSchema,
  macroRunSchema,
  metricsQuerySchema,
  playerActionRequestSchema,
  playerResolveRequestSchema,
  resolveConflictSchema,
  stopServerSchema,
  updateServerSchema,
  type BulkActionResult,
} from '@mmo/protocol/client';

import type { AppContext } from '../../context.js';
import { commandHistory, type ServerRow } from '../../db/schema.js';
import { AppError, conflict, forbidden, notFound } from '../../errors.js';
import { requireUser } from '../auth.js';
import { auditMeta } from './setup-auth.js';

const idParams = z.object({ id: z.string().min(1) });

export function registerServerRoutes(app: FastifyInstance, ctx: AppContext): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const dto = (row: ServerRow) => ctx.servers.toDto(row, ctx.registry.isConnected(row.machineId));
  const broadcast = (row: ServerRow): void => {
    ctx.hub.broadcast({ type: 'server.state', server: dto(row) });
  };
  // Lot 8 : les listes ne montrent à un compte limité que ses portées (les routes `:id` sont
  // gardées par le hook d'auth, celles-ci filtrent).
  const snapshotOf = (request: FastifyRequest) => ctx.permissions.snapshot(requireUser(request).id);

  r.get('/api/servers', (request) => {
    const snapshot = snapshotOf(request);
    return {
      servers: ctx.servers
        .list()
        .filter((row) => ctx.permissions.roleOn(snapshot, { kind: 'server', id: row.id }) !== null)
        .map(dto),
    };
  });

  r.get('/api/servers/conflicts', (request) => {
    const snapshot = snapshotOf(request);
    return {
      conflicts: ctx.servers
        .listConflicts()
        .filter(
          (c) =>
            ctx.permissions.visibleRef(snapshot, { serverId: c.serverId }) ||
            ctx.permissions.visibleRef(snapshot, { machineId: c.found.machineId }),
        ),
    };
  });

  r.post(
    '/api/servers/conflicts/resolve',
    { config: { role: 'admin' }, schema: { body: resolveConflictSchema } },
    async (request) => {
      const { key, resolution } = request.body;
      const row = await ctx.servers.resolveConflict(key, resolution);
      ctx.audit.record({
        ...auditMeta(request),
        action: 'server.conflictResolved',
        targetType: 'server',
        targetId: row?.id,
        targetLabel: row?.name,
        details: { key, resolution },
      });
      if (row) {
        broadcast(row);
        await ctx.registry.get(row.machineId)?.pushConfig();
      }
      return { server: row === undefined ? null : dto(row) };
    },
  );

  r.get('/api/servers/:id', { schema: { params: idParams } }, (request) => ({
    server: dto(ctx.servers.require(request.params.id)),
  }));

  /** Métriques historiques (phase 7) : brut / 1 min / 1 h selon la plage, dernier échantillon. */
  r.get(
    '/api/servers/:id/metrics',
    { schema: { params: idParams, querystring: metricsQuerySchema } },
    (request) => {
      const row = ctx.servers.require(request.params.id);
      return ctx.metricsService.queryServer(row.id, request.query);
    },
  );

  /** Ajout manuel d'un dossier arbitraire (doc 02 §2) : scan ciblé puis adoption. */
  r.post(
    '/api/servers',
    { config: { role: 'admin' }, schema: { body: createServerSchema } },
    async (request, reply) => {
      const user = requireUser(request);
      const machine = ctx.machines.require(request.body.machineId);
      const session = ctx.registry.require(machine.id);
      const res = await session.peer.request(
        'scan.run',
        { paths: [request.body.path] },
        { userId: user.id },
      );
      const detected = res.servers[0];
      if (detected === undefined) {
        throw conflict('no Minecraft server detected in this directory', {
          path: request.body.path,
        });
      }
      if (request.body.name !== undefined) detected.name = request.body.name;
      const result = await ctx.servers.adoptDetected(machine.id, detected, undefined);
      if (!result.server) {
        throw conflict('marker conflict: this directory carries the marker of a known server', {
          conflict: result.conflict,
        });
      }
      ctx.audit.record({
        ...auditMeta(request),
        action: 'server.added',
        targetType: 'server',
        targetId: result.server.id,
        targetLabel: result.server.name,
        details: { path: result.server.path },
      });
      await session.pushConfig();
      broadcast(result.server);
      return reply.code(201).send({ server: dto(result.server) });
    },
  );

  r.patch(
    '/api/servers/:id',
    { config: { role: 'admin' }, schema: { params: idParams, body: updateServerSchema } },
    async (request) => {
      const row = await ctx.servers.update(request.params.id, request.body);
      ctx.audit.record({
        ...auditMeta(request),
        action: 'server.updated',
        targetType: 'server',
        targetId: row.id,
        targetLabel: row.name,
        details: request.body,
      });
      await ctx.registry.get(row.machineId)?.pushConfig();
      broadcast(row);
      return { server: dto(row) };
    },
  );

  r.delete(
    '/api/servers/:id',
    { config: { role: 'admin' }, schema: { params: idParams } },
    async (request, reply) => {
      const row = ctx.servers.require(request.params.id);
      ctx.servers.delete(row.id);
      ctx.relay.forget(row.id);
      ctx.metricsService.deleteServer(row.id);
      ctx.audit.record({
        ...auditMeta(request),
        action: 'server.deleted',
        targetType: 'server',
        targetId: row.id,
        targetLabel: row.name,
        details: { path: row.path },
      });
      await ctx.registry.get(row.machineId)?.pushConfig();
      ctx.events.publish({
        type: 'server.deleted',
        machineId: row.machineId,
        serverId: row.id,
        userId: request.user?.id,
        payload: { name: row.name, path: row.path },
      });
      return reply.code(204).send();
    },
  );

  // --- Actions ----------------------------------------------------------------------------------

  /**
   * Démarrage d'un serveur : l'intention est écrite AVANT l'appel (l'agent la relit dans sa
   * configuration), et **remise à `stopped` si l'appel échoue**. Sans cette compensation, un
   * démarrage refusé — garde-fou mémoire, EULA, Java absent — laissait un serveur marqué « doit
   * tourner » : `restoreOnBoot` le relancerait au prochain démarrage, et depuis les alertes à
   * état il déclencherait « serveur à terre » cinq minutes plus tard.
   */
  async function startServer(
    context: AppContext,
    session: ReturnType<AppContext['registry']['require']>,
    row: ServerRow,
    userId: string,
  ) {
    context.servers.setDesiredState(row.id, 'running');
    await session.pushConfig();
    try {
      return await session.peer.request('server.start', { serverId: row.id }, { userId });
    } catch (error) {
      context.servers.setDesiredState(row.id, 'stopped');
      await session.pushConfig().catch(() => undefined);
      throw error;
    }
  }

  const action = (name: 'start' | 'stop' | 'restart' | 'kill') =>
    `/api/servers/:id/${name}` as const;

  /**
   * Action groupée, **séquentielle**. Le garde-fou mémoire de l'agent compare `maxRamMb` à
   * `total − réserve − somme des maxRamMb des serveurs déjà lancés`, et il est recalculé à chaque
   * requête sans verrou global : dix démarrages en parallèle passent tous la garde avant que le
   * premier ne soit compté, ou s'effondrent en cascade de refus selon le minutage. Enchaîner
   * suffit — `server.start` répond après le spawn, et un serveur en `starting` est déjà compté
   * par l'agent. Inutile donc d'attendre l'état `running`, ce qui rendrait la route bloquante
   * pendant des minutes.
   */
  r.post(
    '/api/servers/bulk-action',
    { config: { role: 'operator' }, schema: { body: bulkActionSchema } },
    async (request) => {
      const user = requireUser(request);
      const snapshot = ctx.permissions.snapshot(user.id);
      const { action: name, serverIds, continueOnError = false } = request.body;
      const results: BulkActionResult['results'] = [];
      let stopped = false;
      for (const id of serverIds) {
        // Lot 8 : un serveur hors portée n'existe pas pour ce compte (même réponse qu'un id inconnu).
        const scope = { kind: 'server', id } as const;
        const row =
          ctx.permissions.roleOn(snapshot, scope) === null ? undefined : ctx.servers.get(id);
        // « Non tenté » se décide AVANT tout le reste : une fois la série interrompue, plus rien
        // n'est évalué, pas même l'existence du serveur.
        if (stopped) {
          results.push({ serverId: id, name: row?.name ?? id, status: 'skipped' });
          continue;
        }
        if (!row) {
          results.push({
            serverId: id,
            name: id,
            status: 'failed',
            error: notFound('server', id).toJSON(),
          });
          if (!continueOnError) stopped = true;
          continue;
        }
        try {
          if (!ctx.permissions.can(snapshot, scope, 'operator')) {
            throw forbidden('role operator required');
          }
          if (row.provisioning !== 'ready') {
            throw conflict(`server is ${row.provisioning}`, { provisioning: row.provisioning });
          }
          const session = ctx.registry.require(row.machineId);
          if (name === 'start') {
            await startServer(ctx, session, row, user.id);
          } else {
            ctx.servers.setDesiredState(row.id, name === 'restart' ? 'running' : 'stopped');
            await session.pushConfig();
            await session.peer.request(
              name === 'stop' ? 'server.stop' : 'server.restart',
              { serverId: row.id },
              { userId: user.id, deadlineMs: 180_000 },
            );
          }
          ctx.audit.record({
            ...auditMeta(request),
            action: `server.${name}`,
            targetType: 'server',
            targetId: row.id,
            targetLabel: row.name,
            details: { bulk: true },
          });
          results.push({ serverId: id, name: row.name, status: 'done' });
        } catch (error) {
          results.push({
            serverId: id,
            name: row.name,
            status: 'failed',
            error: AppError.from(error).toJSON(),
          });
          // On s'arrête au premier refus : sur une machine saturée, insister ne produirait que
          // des refus identiques, et l'utilisateur doit voir LEQUEL a bloqué.
          if (!continueOnError) stopped = true;
        }
      }
      return { results } satisfies BulkActionResult;
    },
  );

  r.post(
    action('start'),
    { config: { role: 'operator' }, schema: { params: idParams } },
    async (request) => {
      const user = requireUser(request);
      const row = ctx.servers.require(request.params.id);
      if (row.provisioning !== 'ready')
        throw conflict(`server is ${row.provisioning}`, { provisioning: row.provisioning });
      const session = ctx.registry.require(row.machineId);
      const res = await startServer(ctx, session, row, user.id);
      ctx.audit.record({
        ...auditMeta(request),
        action: 'server.start',
        targetType: 'server',
        targetId: row.id,
        targetLabel: row.name,
      });
      return { ...res, server: dto(ctx.servers.require(row.id)) };
    },
  );

  r.post(
    action('stop'),
    {
      config: { role: 'operator' },
      schema: { params: idParams, body: stopServerSchema.nullish() },
    },
    async (request) => {
      const user = requireUser(request);
      const row = ctx.servers.require(request.params.id);
      const session = ctx.registry.require(row.machineId);
      ctx.servers.setDesiredState(row.id, 'stopped');
      await session.pushConfig();
      const res = await session.peer.request(
        'server.stop',
        { serverId: row.id, ...(request.body ?? {}) },
        { userId: user.id, deadlineMs: ((request.body?.timeoutSec ?? 120) + 60) * 1000 },
      );
      ctx.audit.record({
        ...auditMeta(request),
        action: 'server.stop',
        targetType: 'server',
        targetId: row.id,
        targetLabel: row.name,
        details: request.body,
      });
      return { ...res, server: dto(ctx.servers.require(row.id)) };
    },
  );

  r.post(
    action('restart'),
    {
      config: { role: 'operator' },
      schema: { params: idParams, body: stopServerSchema.nullish() },
    },
    async (request) => {
      const user = requireUser(request);
      const row = ctx.servers.require(request.params.id);
      const session = ctx.registry.require(row.machineId);
      ctx.servers.setDesiredState(row.id, 'running');
      await session.pushConfig();
      const body = request.body ?? {};
      await session.peer.request(
        'server.restart',
        {
          serverId: row.id,
          ...(body.timeoutSec === undefined ? {} : { timeoutSec: body.timeoutSec }),
          ...(body.announce === undefined ? {} : { announce: body.announce }),
        },
        { userId: user.id, deadlineMs: ((body.timeoutSec ?? 120) + 60) * 1000 },
      );
      ctx.audit.record({
        ...auditMeta(request),
        action: 'server.restart',
        targetType: 'server',
        targetId: row.id,
        targetLabel: row.name,
      });
      return { server: dto(ctx.servers.require(row.id)) };
    },
  );

  r.post(
    action('kill'),
    { config: { role: 'operator' }, schema: { params: idParams } },
    async (request) => {
      const user = requireUser(request);
      const row = ctx.servers.require(request.params.id);
      const session = ctx.registry.require(row.machineId);
      ctx.servers.setDesiredState(row.id, 'stopped');
      await session.pushConfig();
      const res = await session.peer.request(
        'server.kill',
        { serverId: row.id },
        { userId: user.id },
      );
      ctx.audit.record({
        ...auditMeta(request),
        action: 'server.kill',
        targetType: 'server',
        targetId: row.id,
        targetLabel: row.name,
      });
      return { ...res, server: dto(ctx.servers.require(row.id)) };
    },
  );

  r.post(
    '/api/servers/:id/eula-accept',
    { config: { role: 'operator' }, schema: { params: idParams } },
    async (request) => {
      const user = requireUser(request);
      const row = ctx.servers.require(request.params.id);
      await ctx.registry
        .require(row.machineId)
        .peer.request('server.eulaAccept', { serverId: row.id }, { userId: user.id });
      const updated = await ctx.servers.update(row.id, {});
      ctx.audit.record({
        ...auditMeta(request),
        action: 'server.eulaAccepted',
        targetType: 'server',
        targetId: row.id,
        targetLabel: row.name,
      });
      ctx.events.publish({
        type: 'server.eulaAccepted',
        machineId: row.machineId,
        serverId: row.id,
        userId: user.id,
      });
      return { server: dto(updated) };
    },
  );

  // --- Console et commandes ------------------------------------------------------------------

  /**
   * Commandes que CE serveur accepte, lues chez lui. Réservé aux opérateurs, comme l'envoi : un
   * lecteur ne peut pas exécuter de commande, il n'a pas besoin de l'inventaire des mods.
   *
   * Ne passe par aucune des deux routes d'envoi ci-dessous : elles écrivent dans l'historique et
   * dans l'audit, et `help` réapparaîtrait dans le rappel « flèche haut » de l'utilisateur.
   */
  r.get(
    '/api/servers/:id/commands',
    {
      config: { role: 'operator' },
      schema: {
        params: idParams,
        querystring: z.object({ name: z.string().max(64).optional() }),
      },
    },
    async (request) => {
      const row = ctx.servers.require(request.params.id);
      return ctx.commandCatalog.get(row.id, request.query.name);
    },
  );

  /**
   * Envoi d'une commande, avec sa journalisation. Extrait de la route pour que les macros
   * empruntent EXACTEMENT le même chemin : une commande de macro doit apparaître dans
   * l'historique et dans l'audit comme si elle avait été tapée.
   */
  const sendCommand = async (
    request: FastifyRequest,
    row: { id: string; machineId: string; name: string },
    rawCommand: string,
    audit: { action: string; details?: Record<string, unknown> } = { action: 'server.command' },
  ): Promise<{ via: 'stdin' | 'rcon' }> => {
    const user = requireUser(request);
    const command = rawCommand.replace(/^\//, '');
    const res = await ctx.registry
      .require(row.machineId)
      .peer.request('server.command', { serverId: row.id, command }, { userId: user.id });
    ctx.db
      .insert(commandHistory)
      .values({ serverId: row.id, userId: user.id, command, via: res.via, ts: ctx.now() })
      .run();
    ctx.audit.record({
      ...auditMeta(request),
      action: audit.action,
      targetType: 'server',
      targetId: row.id,
      targetLabel: row.name,
      // La macro d'origine est nommée : sinon l'audit montre trois commandes sans dire d'où
      // elles viennent, et « qui a arrêté le serveur » reste sans réponse.
      details: { command, via: res.via, ...audit.details },
    });
    return res;
  };

  r.post(
    '/api/servers/:id/command',
    { config: { role: 'operator' }, schema: { params: idParams, body: commandRequestSchema } },
    async (request) =>
      sendCommand(request, ctx.servers.require(request.params.id), request.body.command),
  );

  // --- Macros de console ----------------------------------------------------------------------

  r.get(
    '/api/servers/:id/macros',
    { config: { role: 'operator' }, schema: { params: idParams } },
    (request) => ({ macros: ctx.macros.list(ctx.servers.require(request.params.id).id) }),
  );

  r.post(
    '/api/servers/:id/macros/:macroId/run',
    {
      config: { role: 'operator' },
      schema: { params: idParams.extend({ macroId: z.string() }), body: macroRunSchema },
    },
    async (request) => {
      const row = ctx.servers.require(request.params.id);
      const macro = ctx.macros.get(request.params.macroId);
      // Le garde-fou est ICI, pas dans le navigateur : la macro a pu gagner un `stop` depuis un
      // autre onglet, et le `destructive` affiché venir d'une liste en cache. Et la confirmation
      // approuve une VERSION (`approvedAt` = le `updatedAt` montré dans le modal) : un booléen
      // seul validerait une séquence modifiée entre l'ouverture du modal et le clic.
      const approved =
        request.body.confirmDestructive === true && request.body.approvedAt === macro.updatedAt;
      if (macro.destructive && !approved) {
        throw new AppError('E_CONFLICT', 'this macro needs an explicit confirmation', {
          details: {
            reason: 'confirm_required',
            commands: macro.commands,
            name: macro.name,
            updatedAt: macro.updatedAt,
          },
        });
      }
      // `run` exécute le DTO vérifié ci-dessus, pas une relecture : rien ne peut changer entre
      // le garde-fou et l'envoi.
      return ctx.macros.run(macro, row.id, (_serverId, command) =>
        sendCommand(request, row, command, {
          action: 'macro.run',
          details: { macroId: macro.id, macroName: macro.name },
        }),
      );
    },
  );

  r.post(
    '/api/macros',
    { config: { role: 'operator' }, schema: { body: macroInputSchema } },
    (request) => {
      const macro = ctx.macros.create(request.body, requireUser(request).id);
      ctx.audit.record({
        ...auditMeta(request),
        action: 'macro.create',
        targetType: 'macro',
        targetId: macro.id,
        targetLabel: macro.name,
        details: { commands: macro.commands.length },
      });
      return { macro };
    },
  );

  r.put(
    '/api/macros/:macroId',
    {
      config: { role: 'operator' },
      schema: { params: z.object({ macroId: z.string() }), body: macroInputSchema },
    },
    (request) => {
      const macro = ctx.macros.update(request.params.macroId, request.body);
      ctx.audit.record({
        ...auditMeta(request),
        action: 'macro.update',
        targetType: 'macro',
        targetId: macro.id,
        targetLabel: macro.name,
      });
      return { macro };
    },
  );

  r.delete(
    '/api/macros/:macroId',
    { config: { role: 'operator' }, schema: { params: z.object({ macroId: z.string() }) } },
    (request, reply) => {
      const macro = ctx.macros.get(request.params.macroId);
      ctx.macros.remove(macro.id);
      ctx.audit.record({
        ...auditMeta(request),
        action: 'macro.delete',
        targetType: 'macro',
        targetId: macro.id,
        targetLabel: macro.name,
      });
      return reply.code(204).send();
    },
  );

  r.post(
    '/api/servers/:id/rcon',
    { config: { role: 'operator' }, schema: { params: idParams, body: commandRequestSchema } },
    async (request) => {
      const user = requireUser(request);
      const row = ctx.servers.require(request.params.id);
      const command = request.body.command.replace(/^\//, '');
      const res = await ctx.registry
        .require(row.machineId)
        .peer.request('server.rcon', { serverId: row.id, command }, { userId: user.id });
      ctx.db
        .insert(commandHistory)
        .values({ serverId: row.id, userId: user.id, command, via: 'rcon', ts: ctx.now() })
        .run();
      ctx.audit.record({
        ...auditMeta(request),
        action: 'server.rcon',
        targetType: 'server',
        targetId: row.id,
        targetLabel: row.name,
        details: { command },
      });
      return res;
    },
  );

  r.get(
    '/api/servers/:id/command-history',
    {
      schema: {
        params: idParams,
        querystring: z.object({ limit: z.coerce.number().int().positive().max(500).optional() }),
      },
    },
    (request) => {
      const row = ctx.servers.require(request.params.id);
      const items = ctx.db
        .select()
        .from(commandHistory)
        .where(eq(commandHistory.serverId, row.id))
        .orderBy(desc(commandHistory.id))
        .limit(request.query.limit ?? 100)
        .all();
      return { history: items };
    },
  );

  /** Snapshot console (ring buffer panel, complété par l'agent si personne ne regardait). */
  r.get(
    '/api/servers/:id/console',
    {
      schema: {
        params: idParams,
        querystring: z.object({ sinceSeq: z.coerce.number().int().nonnegative().optional() }),
      },
    },
    async (request) => {
      const row = ctx.servers.require(request.params.id);
      const since = request.query.sinceSeq ?? 0;
      let snapshot = ctx.relay.snapshot(row.id, since);
      if (snapshot.lines.length === 0 && ctx.hub.subscriberCount(`console:${row.id}`) === 0) {
        const session = ctx.registry.get(row.machineId);
        if (session) {
          const res = await session.peer.request('console.subscribe', {
            serverId: row.id,
            sinceSeq: snapshot.latestSeq,
          });
          ctx.relay.onLines(row.id, res.lines);
          await session.peer
            .request('console.unsubscribe', { serverId: row.id })
            .catch(() => undefined);
          snapshot = ctx.relay.snapshot(row.id, since);
        }
      }
      return snapshot;
    },
  );

  r.get('/api/servers/:id/players', { schema: { params: idParams } }, async (request) => {
    const row = ctx.servers.require(request.params.id);
    const session = ctx.registry.get(row.machineId);
    if (session && row.runState === 'running') {
      try {
        const live = await session.peer.request('player.list', { serverId: row.id });
        return {
          online: live.online,
          max: live.max ?? null,
          players: live.players.map((p) => ({
            name: p.name,
            uuid: p.uuid ?? null,
            joinedAt: null,
          })),
        };
      } catch {
        // repli sur les sessions connues
      }
    }
    const players = ctx.servers.onlinePlayers(row.id);
    return { online: players.length, max: null, players };
  });

  // --- Joueurs (phase 6) ------------------------------------------------------------------------

  /** Historique des connexions (`player_sessions`, doc 04 §4), du plus récent au plus ancien. */
  r.get(
    '/api/servers/:id/players/history',
    {
      schema: {
        params: idParams,
        querystring: z.object({ limit: z.coerce.number().int().positive().max(500).optional() }),
      },
    },
    (request) => {
      const row = ctx.servers.require(request.params.id);
      return { sessions: ctx.servers.playerHistory(row.id, request.query.limit ?? 100) };
    },
  );

  /** Résolution nom → UUID par l'agent (usercache, Mojang ou hors ligne selon `online-mode`). */
  r.post(
    '/api/servers/:id/players/resolve',
    { schema: { params: idParams, body: playerResolveRequestSchema } },
    async (request) => {
      const row = ctx.servers.require(request.params.id);
      return ctx.registry
        .require(row.machineId)
        .peer.request('player.resolve', { serverId: row.id, names: request.body.names });
    },
  );

  /** kick/ban/pardon/op/deop/whitelist — routé par l'agent (commandes si en marche, fichiers sinon). */
  r.post(
    '/api/servers/:id/players/action',
    { config: { role: 'operator' }, schema: { params: idParams, body: playerActionRequestSchema } },
    async (request) => {
      const user = requireUser(request);
      const row = ctx.servers.require(request.params.id);
      const res = await ctx.registry
        .require(row.machineId)
        .peer.request('player.action', { serverId: row.id, ...request.body }, { userId: user.id });
      ctx.audit.record({
        ...auditMeta(request),
        action: `player.${request.body.action}`,
        targetType: 'server',
        targetId: row.id,
        targetLabel: row.name,
        details: { ...request.body, applied: res.applied, warnings: res.warnings },
      });
      ctx.events.publish({
        type: 'player.action',
        machineId: row.machineId,
        serverId: row.id,
        userId: user.id,
        payload: { action: request.body.action, target: request.body.target, applied: res.applied },
      });
      return res;
    },
  );
}
