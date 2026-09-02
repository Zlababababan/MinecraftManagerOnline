/** Endpoints WebSocket : `/ws/agent` (protocole, agents) et `/ws/client` (front, cookie de session). */
import type { FastifyInstance } from 'fastify';

import { AgentSession } from '../../agents/session.js';
import { createServerWsTransport } from '../../agents/ws-transport.js';
import type { AppContext } from '../../context.js';
import { requestVia } from '../../services/access.js';
import { toUserDto } from '../../services/users.js';
import { requireUser } from '../auth.js';

const PROBE_MAX_CONNECTIONS = 8;
const PROBE_TIMEOUT_MS = 15_000;
const PROBE_MAX_FRAME_BYTES = 256 * 1024;
const PROBE_MAX_TOTAL_BYTES = 4 * 1024 * 1024;

export function registerWsRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/ws/agent', { websocket: true, config: { public: true } }, (socket, request) => {
    // Lot 9 : poignées de main limitées par adresse — l'appairage l'était (5/10 min), pas la
    // connexion elle-même, donc pas les tentatives d'`auth.hello`.
    if (!ctx.rateLimits.allow('ws-agent', request.ip)) {
      socket.close(1013, 'too many connections');
      return;
    }
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
      releases: ctx.releases,
      javaRuntimes: ctx.javaRuntimes,
    });
  });

  /**
   * Phase 10 : sonde publique de la couche d'accès — annonce ce que le panel a vu de la requête
   * (`via`) puis renvoie chaque frame telle quelle (texte ou binaire) pendant 15 s au plus.
   */
  // Phase 12 (doc 03 §6) : sonde bornée — connexions simultanées, frames et volume renvoyé.
  let probes = 0;
  app.get('/ws/probe', { websocket: true, config: { public: true } }, (socket, request) => {
    if (probes >= PROBE_MAX_CONNECTIONS) {
      socket.close(1013, 'too many probes');
      return;
    }
    probes++;
    socket.send(JSON.stringify({ type: 'probe', via: requestVia(request.headers), ts: ctx.now() }));
    const timer = setTimeout(() => {
      socket.close(1000, 'probe timeout');
    }, PROBE_TIMEOUT_MS);
    let echoed = 0;
    socket.on('message', (data, isBinary) => {
      const length = Array.isArray(data)
        ? data.reduce((n, b) => n + b.byteLength, 0)
        : (data as { byteLength: number }).byteLength;
      echoed += length;
      if (length > PROBE_MAX_FRAME_BYTES || echoed > PROBE_MAX_TOTAL_BYTES) {
        socket.close(1009, 'probe frame too large');
        return;
      }
      socket.send(data, { binary: isBinary });
    });
    socket.on('close', () => {
      probes--;
      clearTimeout(timer);
    });
  });

  app.get('/ws/client', { websocket: true }, (socket, request) => {
    const user = requireUser(request);
    ctx.hub.attach(socket, toUserDto(user));
  });
}
