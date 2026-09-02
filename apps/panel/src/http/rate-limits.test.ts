/**
 * Lot 9 — limiteurs des surfaces publiques : distribution, relais, poignée de main `/ws/agent`.
 * Bornes abaissées à 3 par fenêtre pour que le quatrième appel soit le refus.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  connectFakeAgent,
  createTestPanel,
  type FakeAgent,
  type TestPanel,
} from '../test/helpers.js';
import { PublicRateLimits } from './rate-limits.js';

describe('limiteurs des surfaces publiques', () => {
  let panel: TestPanel | undefined;
  const agents: FakeAgent[] = [];

  afterEach(async () => {
    for (const a of agents.splice(0)) await a.close().catch(() => undefined);
    await panel?.close();
    panel = undefined;
  });

  it('distribution : 3 requêtes passent, la 4e est refusée 429, toutes surfaces confondues', async () => {
    panel = await createTestPanel({ publicRateLimit: { max: 3, windowMs: 60_000 } });
    const get = (url: string) => panel!.app.inject({ method: 'GET', url });
    expect((await get('/api/dist')).statusCode).toBe(200);
    expect((await get('/install.sh')).statusCode).toBe(200);
    expect((await get('/api/dist/linux-x64')).statusCode).toBeLessThan(500);
    const refused = await get('/dist/anything.tar.gz');
    expect(refused.statusCode).toBe(429);
    expect(refused.json<{ code: string; retryable: boolean }>()).toMatchObject({
      code: 'E_RATE_LIMITED',
      retryable: true,
    });
    // Le relais est une surface distincte : encore ouvert. Un jeton mal formé (400) compte quand
    // même : le limiteur est en `preValidation`, un scan de jetons ne passe pas entre les mailles.
    for (let i = 0; i < 3; i++) {
      expect((await get('/api/relay/unknown-token')).statusCode).toBe(400);
    }
    expect((await get('/api/relay/unknown-token')).statusCode).toBe(429);
    // La fenêtre glisse : une minute plus tard, tout est de nouveau permis.
    panel.clock.advance(60_001);
    expect((await get('/api/dist')).statusCode).toBe(200);
    expect((await get('/api/relay/unknown-token')).statusCode).toBe(400);
  });

  it('/ws/agent : la 4e poignée de main d’une même adresse est fermée 1013', async () => {
    panel = await createTestPanel({ publicRateLimit: { max: 3, windowMs: 60_000 } });
    await panel.listen();
    for (let i = 0; i < 3; i++) agents.push(await connectFakeAgent(panel.wsUrl));
    const fourth = await connectFakeAgent(panel.wsUrl);
    agents.push(fourth);
    expect(await fourth.closed).toBe('1013 too many connections');
  });

  it('PublicRateLimits : une clé par adresse (IPv6 ramenée au /64), une fenêtre par surface', () => {
    let t = 0;
    const limits = new PublicRateLimits({ max: 2, windowMs: 1000, now: () => t });
    expect(limits.allow('relay', '2001:db8:1:2::10')).toBe(true);
    expect(limits.allow('relay', '2001:db8:1:2::20')).toBe(true);
    expect(limits.allow('relay', '2001:db8:1:2::30')).toBe(false);
    expect(limits.allow('distribution', '2001:db8:1:2::30')).toBe(true);
    expect(limits.allow('relay', '2001:db8:9:9::1')).toBe(true);
    t = 1001;
    expect(limits.allow('relay', '2001:db8:1:2::40')).toBe(true);
  });
});
