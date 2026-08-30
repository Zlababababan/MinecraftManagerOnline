/** Gestion d'erreurs HTTP : toute erreur sort en `ApiError` `{ code, message, retryable, details }`. */
import type { FastifyInstance } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from 'fastify-type-provider-zod';

import { isProtocolError } from '@mmo/protocol';

import { AppError } from '../errors.js';
import { sendIndex, wantsSpaFallback } from './static.js';

export interface ErrorHandlerOptions {
  /** Front servi : les navigations inconnues (hors /api et /ws) reçoivent `index.html`. */
  spaFallback?: boolean;
}

export function registerErrorHandler(
  app: FastifyInstance,
  options: ErrorHandlerOptions = {},
): void {
  app.setErrorHandler((error: unknown, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      void reply.code(400).send(
        new AppError('E_VALIDATION', 'request validation failed', {
          details: {
            issues: error.validation.map((v) => ({
              path: v.instancePath,
              message: v.message,
              keyword: v.keyword,
            })),
          },
        }).toJSON(),
      );
      return;
    }
    if (isResponseSerializationError(error)) {
      request.log.error({ err: error }, 'response serialization failed');
      void reply
        .code(500)
        .send(new AppError('E_INTERNAL', 'response serialization failed').toJSON());
      return;
    }
    const fastifyError = error as { statusCode?: number; code?: string; message?: string };
    if (typeof fastifyError.statusCode === 'number' && fastifyError.statusCode < 500) {
      const code =
        fastifyError.statusCode === 404
          ? 'E_NOT_FOUND'
          : fastifyError.statusCode === 401
            ? 'E_AUTH'
            : fastifyError.statusCode === 403
              ? 'E_FORBIDDEN'
              : fastifyError.statusCode === 429
                ? 'E_RATE_LIMITED'
                : 'E_VALIDATION';
      void reply.code(fastifyError.statusCode).send(
        new AppError(code, fastifyError.message ?? 'request error', {
          details: fastifyError.code === undefined ? {} : { fastifyCode: fastifyError.code },
        }).toJSON(),
      );
      return;
    }
    const app = AppError.from(error);
    if (app.status >= 500) {
      request.log.error({ err: error }, app.message);
      // Une erreur venue de l'AGENT est déjà du vocabulaire produit : elle porte un code et un
      // message écrits pour être lus (« EACCES: permission denied, open '…/server.properties' »).
      // L'effacer ne protégeait rien et transformait un diagnostic complet en « internal error ».
      // Seules les exceptions inattendues du panel (SQLite, TypeError…) sont masquées — et elles
      // repartent avec l'identifiant de requête, qui est la clé pour retrouver la ligne de journal.
      if (isProtocolError(error)) {
        void reply.code(app.status).send(app.toJSON());
        return;
      }
      void reply.code(app.status).send({
        ...app.toJSON(),
        message: 'internal error',
        details: { requestId: request.id },
      });
      return;
    }
    request.log.info({ code: app.code }, app.message);
    void reply.code(app.status).send(app.toJSON());
  });

  app.setNotFoundHandler((request, reply) => {
    if (options.spaFallback === true && wantsSpaFallback(request)) {
      void sendIndex(reply);
      return;
    }
    void reply.code(404).send(new AppError('E_NOT_FOUND', 'route not found').toJSON());
  });
}
