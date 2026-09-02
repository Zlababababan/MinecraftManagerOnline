/**
 * Lot 9 — métrique `agent.self` : le coût du processus agent (RSS, CPU) voyage dans le heartbeat
 * et ressort dans `MachineDto.heartbeat` et sur `/ws/client`. Un agent N-1 qui ne l'envoie pas
 * donne un DTO sans ces champs, jamais un défaut inventé.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { MachineDto } from '@mmo/protocol/client';

import {
  connectClient,
  connectFakeAgent,
  createTestPanel,
  helloPayload,
  pairPayload,
  setupAdmin,
  waitFor,
  type FakeAgent,
  type TestPanel,
} from '../test/helpers.js';

describe('heartbeat — coût du processus agent', () => {
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

  it('agentRssMb / agentCpuPct ressortent dans le DTO et le message machine.heartbeat', async () => {
    const res = await panel.app.inject({
      method: 'POST',
      url: '/api/machines',
      payload: { name: 'Tour' },
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
    await a.peer.request('auth.hello', helloPayload(machine.id, secret));
    const client = await connectClient(panel.wsUrl, admin);

    // Agent N-1 : heartbeat sans les champs → DTO sans les champs.
    a.peer.emit('agent.heartbeat', { ts: Date.now(), activeServers: 0, activeTasks: 0 });
    const dtoOf = async () =>
      (
        await panel.app.inject({
          method: 'GET',
          url: `/api/machines/${machine.id}`,
          headers: { cookie: admin },
        })
      ).json<{ machine: MachineDto }>().machine;
    await waitFor(async () => (await dtoOf()).heartbeat !== undefined, 5000);
    expect((await dtoOf()).heartbeat).not.toHaveProperty('agentRssMb');

    a.peer.emit('agent.heartbeat', {
      ts: Date.now(),
      activeServers: 0,
      activeTasks: 0,
      agentRssMb: 85.5,
      agentCpuPct: 0.3,
    });
    await waitFor(async () => (await dtoOf()).heartbeat?.agentRssMb !== undefined, 5000);
    expect((await dtoOf()).heartbeat).toMatchObject({ agentRssMb: 85.5, agentCpuPct: 0.3 });
    // Diffusé tel quel aux navigateurs.
    await waitFor(
      () =>
        client.messages.some(
          (m) =>
            (m as { type?: string; heartbeat?: { agentRssMb?: number } }).type ===
              'machine.heartbeat' &&
            (m as { heartbeat?: { agentRssMb?: number } }).heartbeat?.agentRssMb === 85.5,
        ),
      5000,
    );
    client.close();
  });
});
