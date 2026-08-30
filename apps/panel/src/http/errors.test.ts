/**
 * Ce que le navigateur reçoit d'une erreur 5xx. Le défaut corrigé ici a coûté une soirée de
 * diagnostic à distance : un refus de droits de l'agent, parfaitement explicite dans ses journaux,
 * arrivait à l'écran en « Start internal error » parce que le panel remplaçait TOUT message de
 * 5xx par « internal error ».
 */
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { ProtocolError } from '@mmo/protocol';

import { AppError } from '../errors.js';
import { registerErrorHandler } from './errors.js';

interface ApiErrorBody {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

async function panelThatThrows(error: unknown) {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);
  app.get('/boom', () => {
    throw error;
  });
  await app.ready();
  const res = await app.inject({ method: 'GET', url: '/boom' });
  await app.close();
  return { status: res.statusCode, body: JSON.parse(res.body) as ApiErrorBody };
}

describe('sortie des erreurs HTTP', () => {
  it('relaie intégralement une erreur venue de l’agent', async () => {
    const { status, body } = await panelThatThrows(
      new ProtocolError('E_IO', 'EACCES: /srv/mc/server.properties (running as mmo)', {
        retryable: false,
        details: { reason: 'EACCES', path: '/srv/mc/server.properties', user: 'mmo' },
      }),
    );
    expect(status).toBe(502);
    expect(body.code).toBe('E_IO');
    expect(body.message).toContain('/srv/mc/server.properties');
    // Les détails portent la variante d'affichage (`E_IO_EACCES`) : sans eux l'UI ne dirait que
    // « erreur disque ou réseau », ce qui n'aide personne.
    expect(body.details).toMatchObject({ reason: 'EACCES', user: 'mmo' });
  });

  it('masque une exception interne, mais laisse de quoi retrouver la trace', async () => {
    const { status, body } = await panelThatThrows(
      new TypeError('cannot read properties of undefined (reading secret)'),
    );
    expect(status).toBe(500);
    expect(body.code).toBe('E_INTERNAL');
    expect(body.message).toBe('internal error');
    expect(body.message).not.toContain('secret');
    expect(body.details?.requestId).toBeTruthy();
  });

  it('laisse passer les erreurs métier du panel sous 500', async () => {
    const { status, body } = await panelThatThrows(
      new AppError('E_NOT_FOUND', 'unknown server srv_9'),
    );
    expect(status).toBe(404);
    expect(body.message).toBe('unknown server srv_9');
  });
});
