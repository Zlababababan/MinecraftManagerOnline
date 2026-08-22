/** Endpoints WebSocket : `/ws/agent` (protocole, agents) et `/ws/client` (front, cookie de session). */
import type { FastifyInstance } from 'fastify';

import { AgentSession } from '../../agents/session.js';
import { createServerWsTransport } from '../../agents/ws-transport.js';
import type { AppContext } from '../../context.js';
import { toUserDto } from '../../services/users.js';
import { requireUser } from '../auth.js';

export function registerWsRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/ws/agent', { websocket: true, config: { public: true } }, (socket, request) => {
    const transport = createServerWsTransport(socket, request.ip);
    new AgentSession(transport, {
      config: ctx.config,
      logger: ctx.logger,
      now: ctx.now,
      machines: ctx.machines,
      servers: ctx.servers,
      metrics: ctx.metricsService,
      events: ctx.events,
      audit: ctx.audit,
      processed: ctx.processed,
      registry: ctx.registry,
      relay: ctx.relay,
      hub: ctx.hub,
      tasks: ctx.tasks,
      backups: ctx.backups,
      transfers: ctx.transfers,
    });
  });

  app.get('/ws/client', { websocket: true }, (socket, request) => {
    const user = requireUser(request);
    ctx.hub.attach(socket, toUserDto(user));
  });
}
