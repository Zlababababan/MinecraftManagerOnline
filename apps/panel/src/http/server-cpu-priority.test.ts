/**
 * Priorité CPU par serveur (remontée d'usage « un onglet Twitch qui rame ») : réglage par PATCH,
 * exposé au navigateur, poussé à l'agent dans `agent.configure` — et **absent** de la configuration
 * quand il vaut « normale », pour qu'un serveur ordinaire envoie exactement ce qu'il envoyait
 * avant (ajout sans bump : un agent N-1 ne voit rien de nouveau).
 *
 * La colonne n'a volontairement pas de CHECK SQL (en ajouter un ferait recréer `servers`, avec ses
 * cascades) : c'est Zod qui refuse une valeur inventée, et ce test le prouve.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ServerConfig } from '@mmo/protocol';

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

describe('priorité CPU d’un serveur', () => {
  let panel: TestPanel;
  let admin: string;
  let machineId: string;
  let serverId: string;

  const configOf = (): ServerConfig => {
    const pushed = panel.ctx.servers.buildAgentConfig(machineId).servers ?? [];
    const found = pushed.find((c) => c.serverId === serverId);
    if (!found) throw new Error('serveur absent de la configuration poussée');
    return found;
  };

  const patch = (payload: Record<string, unknown>) =>
    panel.app.inject({
      method: 'PATCH',
      url: `/api/servers/${serverId}`,
      payload,
      headers: { cookie: admin },
    });

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

  it('vaut « normale » par défaut, et n’ajoute alors rien à la configuration de l’agent', () => {
    expect(panel.ctx.servers.require(serverId).cpuPriority).toBe('normal');
    expect(configOf().cpuPriority).toBeUndefined();
  });

  it('se règle par PATCH, se lit dans le DTO et part à l’agent', async () => {
    const res = await patch({ cpuPriority: 'below_normal' });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ server: { cpuPriority: string } }>().server.cpuPriority).toBe('below_normal');
    expect(configOf().cpuPriority).toBe('below_normal');

    expect((await patch({ cpuPriority: 'low' })).statusCode).toBe(200);
    expect(configOf().cpuPriority).toBe('low');

    // Retour à la normale : le champ disparaît de nouveau de la configuration.
    expect((await patch({ cpuPriority: 'normal' })).statusCode).toBe(200);
    expect(configOf().cpuPriority).toBeUndefined();
  });

  it('refuse une valeur inventée (c’est Zod qui tient, la colonne n’a pas de CHECK)', async () => {
    for (const bad of ['idle', 'BELOW_NORMAL', '', '19']) {
      const res = await patch({ cpuPriority: bad });
      expect(res.statusCode, `valeur « ${bad} »`).toBe(400);
      expect(res.json<{ code: string }>().code).toBe('E_VALIDATION');
    }
    expect(panel.ctx.servers.require(serverId).cpuPriority).toBe('normal');
  });
});
