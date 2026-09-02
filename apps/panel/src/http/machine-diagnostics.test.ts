/**
 * Lot 9 — `GET /api/machines/:id/diagnostics` : relaie `agent.diagnostics` borné à l'agent, masque,
 * sert en pièce jointe texte, audite ; un agent N-1 (sans le type) donne un 501 lisible.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { RequestPayload, ResponsePayload } from '@mmo/protocol';

import {
  connectFakeAgent,
  createTestPanel,
  createUser,
  helloPayload,
  pairPayload,
  setupAdmin,
  type FakeAgent,
  type TestPanel,
} from '../test/helpers.js';

const DIAG: ResponsePayload<'agent.diagnostics'> = {
  agentVersion: '1.0.8',
  runtimeVersion: 'v24.19.0',
  machine: { hostname: 'gaming-pc', os: 'windows', arch: 'x64' },
  pid: 4242,
  startedAt: 1_787_300_000_000,
  uptimeSec: 60,
  stateDir: 'C:\\Users\\jean\\AppData\\Local\\mmo-agent',
  rssMb: 80,
  connected: true,
  servers: [],
  activeTasks: 0,
  capabilities: ['rcon', 'diagnostics'],
  log: {
    file: 'agent-2026-09-02.log',
    lines: ['2026-09-02T04:00:00.000Z INFO  [agent] EACCES /home/jean/mc password=hunter2'],
    truncated: false,
  },
};

describe('GET /api/machines/:id/diagnostics', () => {
  let panel: TestPanel;
  let admin: string;
  const agents: FakeAgent[] = [];

  beforeEach(async () => {
    panel = await createTestPanel();
    await panel.listen();
    admin = await setupAdmin(panel);
  });
  afterEach(async () => {
    for (const a of agents.splice(0)) await a.close().catch(() => undefined);
    await panel.close();
  });

  /** Machine appairée et agent authentifié ; `withHandler` = agent à jour (N) ou ancien (N-1). */
  async function onlineMachine(withHandler: boolean): Promise<{
    machineId: string;
    received: RequestPayload<'agent.diagnostics'>[];
  }> {
    const res = await panel.app.inject({
      method: 'POST',
      url: '/api/machines',
      payload: { name: 'Tour du salon' },
      headers: { cookie: admin },
    });
    const { machine, pairing } = res.json<{
      machine: { id: string };
      pairing: { code: string };
    }>();
    const pairer = await connectFakeAgent(panel.wsUrl);
    const { secret } = await pairer.peer.request('pair.request', pairPayload(pairing.code));
    await pairer.close();

    const a = await connectFakeAgent(panel.wsUrl);
    agents.push(a);
    a.peer.handle('agent.configure', () => ({ applied: true as const }));
    const received: RequestPayload<'agent.diagnostics'>[] = [];
    if (withHandler) {
      a.peer.handle('agent.diagnostics', (req) => {
        received.push(req);
        return DIAG;
      });
    }
    await a.peer.request(
      'auth.hello',
      helloPayload(machine.id, secret, {
        capabilities: withHandler ? ['rcon', 'diagnostics'] : ['rcon'],
      }),
    );
    return { machineId: machine.id, received };
  }

  it('sert le diagnostic masqué en pièce jointe texte, borné, audité', async () => {
    const { machineId, received } = await onlineMachine(true);
    const res = await panel.app.inject({
      method: 'GET',
      url: `/api/machines/${machineId}/diagnostics?lines=50`,
      headers: { cookie: admin },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="mmo-agent-Tour_du_salon-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.txt"$/,
    );
    // Bornes transmises telles quelles à l'agent (le plafond d'octets est fixé par le panel).
    expect(received).toEqual([{ logLines: 50, logMaxBytes: 262_144 }]);
    expect(res.body).toContain('machine: Tour du salon (' + machineId + ')');
    expect(res.body).toContain('state dir: C:\\Users\\<user>\\AppData\\Local\\mmo-agent');
    expect(res.body).toContain('EACCES /home/<user>/mc password=<redacted>');
    expect(res.body).not.toContain('jean');
    expect(res.body).not.toContain('hunter2');
    expect(
      panel.ctx.audit
        .list(20)
        .some((row) => row.action === 'machine.diagnostics' && row.targetId === machineId),
    ).toBe(true);

    // Sans paramètre : 200 lignes par défaut.
    await panel.app.inject({
      method: 'GET',
      url: `/api/machines/${machineId}/diagnostics`,
      headers: { cookie: admin },
    });
    expect(received[1]).toEqual({ logLines: 200, logMaxBytes: 262_144 });
  });

  it('agent N-1 (type inconnu) → 501 E_UNSUPPORTED_TYPE, jamais une erreur interne', async () => {
    const { machineId } = await onlineMachine(false);
    const res = await panel.app.inject({
      method: 'GET',
      url: `/api/machines/${machineId}/diagnostics`,
      headers: { cookie: admin },
    });
    expect(res.statusCode).toBe(501);
    expect(res.json<{ code: string }>().code).toBe('E_UNSUPPORTED_TYPE');
  });

  it('réservé aux administrateurs, et refusé quand l’agent est hors ligne', async () => {
    const { machineId } = await onlineMachine(true);
    const operator = await createUser(panel, admin, {
      username: 'op',
      password: 'operator-pass',
      role: 'operator',
    });
    const forbidden = await panel.app.inject({
      method: 'GET',
      url: `/api/machines/${machineId}/diagnostics`,
      headers: { cookie: operator },
    });
    expect(forbidden.statusCode).toBe(403);

    for (const a of agents.splice(0)) await a.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const offline = await panel.app.inject({
      method: 'GET',
      url: `/api/machines/${machineId}/diagnostics`,
      headers: { cookie: admin },
    });
    // Agent hors ligne : refus nommé (503, comme toute indisponibilité), jamais une erreur interne.
    expect(offline.statusCode).toBe(503);
    expect(offline.json<{ code: string }>().code).toBe('E_AGENT_OFFLINE');
  });
});
