/**
 * Favori d'un serveur (passe UX du 01/10) : une étoile qui l'épingle en tête du tableau de bord
 * et de la liste. Pur affichage : enregistré côté panel (il suit l'utilisateur d'un appareil à
 * l'autre), jamais poussé à l'agent, et `updatedAt` ne bouge pas.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestPanel, setupAdmin, type TestPanel } from '../test/helpers.js';

function detected(path: string, name: string, gamePort: number) {
  return {
    path,
    name,
    loader: { value: 'vanilla' as const, confidence: 'high' as const, source: 'jar_name' },
    mcVersion: { value: '1.20.1', confidence: 'high' as const, source: 'jar_manifest' },
    maxRamMb: { value: 2048, confidence: 'medium' as const, source: 'run_script' },
    gamePort,
    eulaAccepted: true,
    launch: { kind: 'jar' as const, jar: 'server.jar' },
    javaRequirement: { majorVersion: 17, strict: false, source: 'table' as const },
    confidence: 'high' as const,
    evidence: [],
  };
}

describe('favori d’un serveur', () => {
  let panel: TestPanel;
  let admin: string;
  let machineId: string;
  let serverId: string;

  const put = (payload: Record<string, unknown>, cookie: string | null = admin) =>
    panel.app.inject({
      method: 'PUT',
      url: `/api/servers/${serverId}/favorite`,
      payload,
      headers: cookie === null ? {} : { cookie },
    });
  const listed = async (): Promise<boolean | undefined> => {
    const res = await panel.app.inject({
      method: 'GET',
      url: '/api/servers',
      headers: { cookie: admin },
    });
    return res
      .json<{ servers: { id: string; favorite?: boolean }[] }>()
      .servers.find((s) => s.id === serverId)?.favorite;
  };

  beforeEach(async () => {
    panel = await createTestPanel();
    admin = await setupAdmin(panel);
    const res = await panel.app.inject({
      method: 'POST',
      url: '/api/machines',
      payload: { name: 'PC' },
      headers: { cookie: admin },
    });
    machineId = res.json<{ machine: { id: string } }>().machine.id;
    const adopted = await panel.ctx.servers.adoptDetected(
      machineId,
      detected('/srv/a', 'A', 25_565),
      undefined,
    );
    serverId = adopted.server?.id ?? '';
    expect(serverId).not.toBe('');
  });
  afterEach(async () => {
    await panel.close();
  });

  it('n’est pas favori par défaut', async () => {
    expect(await listed()).toBe(false);
  });

  it('s’épingle et se désépingle, se lit dans la liste, sans toucher à `updatedAt` ni à l’agent', async () => {
    const before = panel.ctx.servers.require(serverId).updatedAt;
    const config = JSON.stringify(panel.ctx.servers.buildAgentConfig(machineId));

    const on = await put({ favorite: true });
    expect(on.statusCode).toBe(200);
    expect(on.json<{ server: { favorite: boolean } }>().server.favorite).toBe(true);
    expect(await listed()).toBe(true);
    expect(panel.ctx.servers.require(serverId).updatedAt).toBe(before);
    expect(JSON.stringify(panel.ctx.servers.buildAgentConfig(machineId))).toBe(config);

    expect((await put({ favorite: false })).statusCode).toBe(200);
    expect(await listed()).toBe(false);
  });

  it('refuse un corps invalide, un serveur inconnu et un visiteur sans session', async () => {
    expect((await put({ favorite: 'oui' })).statusCode).toBe(400);
    expect((await put({})).statusCode).toBe(400);
    expect((await put({ favorite: true }, null)).statusCode).toBe(401);
    expect(await listed()).toBe(false);
    const unknown = await panel.app.inject({
      method: 'PUT',
      url: '/api/servers/nope/favorite',
      payload: { favorite: true },
      headers: { cookie: admin },
    });
    expect(unknown.statusCode).toBe(404);
  });
});
