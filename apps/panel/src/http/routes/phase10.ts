/**
 * Phase 10 — routes : push (clé VAPID, abonnements, test), préférences et centre de notifications,
 * couche d'accès (statut, test de joignabilité, certificat ACME, DynDNS, règles pare-feu), adresse à
 * donner aux amis et test Server List Ping par serveur.
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import {
  accessTestRequestSchema,
  notificationPrefsPutSchema,
  notificationsQuerySchema,
  notificationsSeenSchema,
  pushSubscribeSchema,
  quietHoursPutSchema,
  serverMutePutSchema,
  pushUnsubscribeSchema,
  reachabilityRequestSchema,
  type PushStatusDto,
} from '@mmo/protocol/client';

import type { AppContext } from '../../context.js';
import { requireUser } from '../auth.js';
import { auditMeta } from './setup-auth.js';

const idParams = z.object({ id: z.string().min(1) });

export function registerPhase10Routes(app: FastifyInstance, ctx: AppContext): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // --- Push --------------------------------------------------------------------------------------

  r.get('/api/push', (request): PushStatusDto => {
    const user = requireUser(request);
    return {
      vapidPublicKey: ctx.notifications.vapid()?.publicKey ?? null,
      subscriptions: ctx.notifications.subscriptions(user.id),
    };
  });

  r.post('/api/push/subscribe', { schema: { body: pushSubscribeSchema } }, (request) => {
    const user = requireUser(request);
    const ua = request.body.userAgent ?? request.headers['user-agent']?.slice(0, 512);
    return {
      subscription: ctx.notifications.subscribe(user.id, {
        ...request.body,
        ...(ua === undefined ? {} : { userAgent: ua }),
      }),
    };
  });

  r.post('/api/push/unsubscribe', { schema: { body: pushUnsubscribeSchema } }, (request) => {
    const user = requireUser(request);
    return { removed: ctx.notifications.unsubscribe(user.id, request.body.endpoint) };
  });

  r.post('/api/push/test', async (request) => {
    const user = requireUser(request);
    return await ctx.notifications.sendTest(user.id);
  });

  // --- Préférences et centre -----------------------------------------------------------------------

  // `prefs` reste le réglage commun hérité ; `channels` porte le réglage effectif par canal,
  // c'est lui que l'écran manipule.
  r.get('/api/notifications/prefs', (request) => {
    const userId = requireUser(request).id;
    return {
      prefs: ctx.notifications.prefs(userId),
      channels: ctx.notifications.channelPrefs(userId),
      quietHours: ctx.notifications.quietHours(userId),
      // Le fuseau des heures calmes est celui du panel : l'écran l'affiche pour qu'on ne règle
      // pas « 22 h » en croyant que c'est l'heure de son propre téléphone.
      timeZone: ctx.settings.timeZone(),
      // Un serveur mis en silence puis retiré du panel n'a plus de nom : la ligne est ignorée
      // plutôt qu'affichée sans rien dire (la cascade l'aura de toute façon effacée).
      mutedServers: ctx.notifications
        .mutes(userId)
        .flatMap((m) => {
          const server = ctx.servers.get(m.serverId);
          return server === undefined
            ? []
            : [{ serverId: m.serverId, name: server.name, mutedAt: m.mutedAt }];
        })
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  });

  /** Heures calmes : `null` retire le réglage (il ne se met pas à zéro). */
  r.put('/api/notifications/quiet-hours', { schema: { body: quietHoursPutSchema } }, (request) => ({
    quietHours: ctx.notifications.setQuietHours(requireUser(request).id, request.body.quietHours),
  }));

  /**
   * Silence d'un serveur POUR SOI. Route sous `/api/servers/:id` exprès : le contrôle de portée
   * du lot 8 s'y applique déjà, on ne peut donc pas mettre en silence un serveur qu'on ne voit
   * pas — et un identifiant inventé répond « introuvable » comme partout ailleurs.
   */
  r.put(
    '/api/servers/:id/notifications',
    { schema: { params: idParams, body: serverMutePutSchema } },
    (request) => {
      const server = ctx.servers.require(request.params.id);
      return {
        muted: ctx.notifications.setMuted(requireUser(request).id, server.id, request.body.muted),
      };
    },
  );

  r.get('/api/servers/:id/notifications', { schema: { params: idParams } }, (request) => {
    const server = ctx.servers.require(request.params.id);
    return { muted: ctx.notifications.mutedServerIds(requireUser(request).id).has(server.id) };
  });

  r.put(
    '/api/notifications/prefs',
    { schema: { body: notificationPrefsPutSchema } },
    (request) => ({
      channels: ctx.notifications.setPrefs(requireUser(request).id, request.body),
    }),
  );

  r.get('/api/notifications', { schema: { querystring: notificationsQuerySchema } }, (request) =>
    ctx.notifications.list(requireUser(request).id, request.query.limit ?? 50),
  );

  r.post('/api/notifications/seen', { schema: { body: notificationsSeenSchema } }, (request) => ({
    seenId: ctx.notifications.markSeen(requireUser(request).id, request.body.id),
  }));

  // --- Couche d'accès ------------------------------------------------------------------------------

  r.get('/api/access', (request) => ({ access: ctx.access.status(request.headers) }));

  r.get('/api/access/firewall', { config: { role: 'admin' } }, () => ({
    rules: ctx.access.firewallRules(),
  }));

  r.post(
    '/api/access/test',
    { config: { role: 'admin' }, schema: { body: accessTestRequestSchema } },
    async (request) => {
      const result = await ctx.access.testReachability(request.body.url);
      ctx.audit.record({
        ...auditMeta(request),
        action: 'access.tested',
        details: { url: result.url, ok: result.ok, via: result.via },
      });
      return { result };
    },
  );

  r.post('/api/access/certificate', { config: { role: 'admin' } }, async (request) => {
    const certificate = await ctx.access.issueCertificate();
    ctx.audit.record({
      ...auditMeta(request),
      action: 'access.certificateRequested',
      details: { names: certificate.names },
    });
    return { certificate };
  });

  r.post('/api/access/dyndns', { config: { role: 'admin' } }, async (request) => {
    const result = await ctx.access.updateDynDns();
    ctx.audit.record({ ...auditMeta(request), action: 'access.dyndnsUpdated', details: result });
    return result;
  });

  // --- Serveurs : adresse et joignabilité ----------------------------------------------------------

  r.get('/api/servers/:id/address', { schema: { params: idParams } }, (request) => ({
    address: ctx.access.serverAddress(ctx.servers.require(request.params.id)),
  }));

  r.post(
    '/api/servers/:id/reachability',
    { config: { role: 'operator' }, schema: { params: idParams, body: reachabilityRequestSchema } },
    async (request) => ({
      result: await ctx.access.testServer(
        ctx.servers.require(request.params.id),
        request.body.address,
      ),
    }),
  );
}
