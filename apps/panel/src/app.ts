import { PROTOCOL_VERSION } from '@mmo/protocol';
import { PROJECT_NAME } from '@mmo/shared';
import Fastify, { type FastifyInstance } from 'fastify';

export interface AppOptions {
  logger?: boolean;
}

/** Construit l'instance Fastify (sans écouter) — utilisée par `main.ts` et par les tests via `inject`. */
export function buildApp(options: AppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });

  app.get('/api/health', () => ({
    ok: true,
    name: PROJECT_NAME,
    protocolVersion: PROTOCOL_VERSION,
    time: Date.now(),
  }));

  return app;
}
