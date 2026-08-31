/**
 * Le catalogue est lu chez le serveur, à travers l'agent. Trois propriétés comptent plus que la
 * richesse du résultat : ne pas laisser de trace dans l'historique de commandes de l'utilisateur,
 * ne pas partir en rafale quand deux navigateurs regardent la même console, et ne jamais faire
 * échouer une requête parce qu'un serveur est arrêté ou qu'un agent est trop ancien.
 */
import { describe, expect, it, vi } from 'vitest';

import { ProtocolError } from '@mmo/protocol';

import { CommandCatalogService, type CommandCatalogDeps } from './command-catalog.js';

const HELP = ['/whitelist (on|off|list|reload)', '/whitelist (add|remove) <targets>', '/say ...'];

function service(over: Partial<CommandCatalogDeps> = {}, respond = () => HELP) {
  let now = 1_000_000;
  const request = vi.fn(() =>
    Promise.resolve({ available: true, lines: respond(), truncated: false }),
  );
  const deps = {
    registry: { require: () => ({ peer: { request } }) },
    servers: { get: () => ({ id: 'srv_1', machineId: 'm1' }) },
    now: () => now,
    logger: { debug: () => undefined },
    ...over,
  } as unknown as CommandCatalogDeps;
  return {
    svc: new CommandCatalogService(deps),
    request,
    advance: (ms: number) => (now += ms),
  };
}

describe('catalogue des commandes', () => {
  it('transforme les lignes du serveur en modèle exploitable', async () => {
    const { svc } = service();
    const catalog = await svc.get('srv_1');
    expect(catalog.source).toBe('discovered');
    expect(catalog.commands.map((c) => c.name)).toEqual(['say', 'whitelist']);
    expect(catalog.commands.find((c) => c.name === 'whitelist')?.usages).toHaveLength(2);
    // `...` : l'arbre de `say` n'est pas déplié, l'aperçu devra le dire.
    expect(catalog.commands.find((c) => c.name === 'say')?.deep).toBe(false);
  });

  it('n’interroge le serveur qu’une fois pour deux consultations simultanées', async () => {
    const { svc, request } = service();
    await Promise.all([svc.get('srv_1'), svc.get('srv_1')]);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('garde le résultat un moment, puis le redemande', async () => {
    const { svc, request, advance } = service();
    await svc.get('srv_1');
    await svc.get('srv_1');
    expect(request).toHaveBeenCalledTimes(1);
    advance(6 * 60_000);
    await svc.get('srv_1');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('oublie ce qu’il savait quand le serveur redémarre', async () => {
    const { svc, request } = service();
    await svc.get('srv_1');
    svc.invalidate('srv_1');
    await svc.get('srv_1');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('rend « indisponible » plutôt qu’une erreur, quelle qu’en soit la cause', async () => {
    // Agent trop ancien : il ne connaît pas la requête. La moitié du parc sera dans ce cas
    // pendant des semaines — ce n'est pas une panne, et surtout pas une notification rouge.
    const oldAgent = service({
      registry: {
        require: () => ({
          peer: {
            request: () =>
              Promise.reject(new ProtocolError('E_UNSUPPORTED_TYPE', 'unknown request')),
          },
        }),
      },
    } as unknown as Partial<CommandCatalogDeps>);
    await expect(oldAgent.svc.get('srv_1')).resolves.toMatchObject({
      source: 'unavailable',
      commands: [],
    });

    // Machine hors ligne.
    const offline = service({
      registry: {
        require: () => {
          throw new ProtocolError('E_AGENT_OFFLINE' as 'E_INTERNAL', 'offline');
        },
      },
    } as unknown as Partial<CommandCatalogDeps>);
    await expect(offline.svc.get('srv_1')).resolves.toMatchObject({ source: 'unavailable' });

    // « Disponible » mais rien d'exploitable (réponse vide, help moddé non parsable) :
    // équivalent à indisponible — un catalogue « découvert » de zéro commande masquerait la
    // pastille « liste générique » alors que la complétion s'y rabat justement.
    const emptySweep = service({}, () => []);
    await expect(emptySweep.svc.get('srv_1')).resolves.toMatchObject({
      source: 'unavailable',
      commands: [],
    });

    // Serveur arrêté ou RCON absent : l'agent répond `available: false`.
    const withFalse = new CommandCatalogService({
      registry: {
        require: () => ({
          peer: {
            request: () => Promise.resolve({ available: false, lines: [], truncated: false }),
          },
        }),
      },
      servers: { get: () => ({ id: 'srv_1', machineId: 'm1' }) },
      now: () => 1,
      logger: { debug: () => undefined },
    } as unknown as CommandCatalogDeps);
    await expect(withFalse.get('srv_1')).resolves.toMatchObject({ source: 'unavailable' });
  });

  it('un serveur inconnu ne fait pas d’aller-retour', async () => {
    const { svc, request } = service({
      servers: { get: () => undefined },
    } as unknown as Partial<CommandCatalogDeps>);
    await expect(svc.get('srv_absent')).resolves.toMatchObject({ source: 'unavailable' });
    expect(request).not.toHaveBeenCalled();
  });

  it('un dépliage enrichit le catalogue sans le remplacer', async () => {
    let lines = HELP;
    const { svc } = service({}, () => lines);
    await svc.get('srv_1');
    lines = ['/say <message...>'];
    const after = await svc.get('srv_1', 'say');
    // `whitelist` est toujours là, et `say` a gagné sa vraie forme.
    expect(after.commands.map((c) => c.name)).toEqual(['say', 'whitelist']);
    expect(after.commands.find((c) => c.name === 'say')?.deep).toBe(true);
  });

  it('ne reçoit même pas de quoi écrire dans l’historique de commandes', () => {
    // Garde structurelle au niveau des TYPES : ajouter `db` ou `audit` aux dépendances fait
    // échouer la COMPILATION de ce test — l'ancienne liste écrite à la main ne surveillait
    // qu'elle-même. `help` ne doit jamais remonter dans le rappel « flèche haut ».
    type Forbidden = Extract<keyof CommandCatalogDeps, 'db' | 'audit'>;
    const guard: [Forbidden] extends [never] ? true : never = true;
    expect(guard).toBe(true);
  });
});
