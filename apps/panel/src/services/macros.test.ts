/**
 * Une macro exécute de vraies commandes d'un seul clic. Ce qui compte n'est donc pas qu'elle
 * marche, mais qu'elle échoue proprement : s'arrêter au premier refus plutôt que de dérouler la
 * suite dans le vide, et prévenir avant les séquences qui arrêtent ou détruisent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProtocolError } from '@mmo/protocol';

import { servers, users } from '../db/schema.js';
import { agentOffline } from '../errors.js';
import { createTestPanel, setupAdmin, type TestPanel } from '../test/helpers.js';
import { isDestructive, MacrosService, splitCommands } from './macros.js';

describe('lecture d’une séquence', () => {
  it('ignore les lignes vides et le slash initial', () => {
    expect(splitCommands('  /say bonjour \n\n  list  \n')).toEqual(['say bonjour', 'list']);
    expect(splitCommands('   ')).toEqual([]);
  });

  it('reconnaît ce qui mérite une confirmation', () => {
    expect(isDestructive(['say bonjour', 'list'])).toBe(false);
    expect(isDestructive(['say au revoir', 'stop'])).toBe(true);
    expect(isDestructive(['kill @e[type=item]'])).toBe(true);
    // `save-off` sans `save-on` derrière laisse le serveur sans sauvegarde : à confirmer aussi.
    expect(isDestructive(['save-off'])).toBe(true);
    // Un mot qui commence pareil n'est pas la commande : `stopsound` ne casse rien.
    expect(isDestructive(['stopsound @a'])).toBe(false);
    expect(isDestructive(['banlist players'])).toBe(false);
  });
});

describe('service des macros', () => {
  let panel: TestPanel;
  let svc: MacrosService;
  let userId: string;
  let serverId: string;

  beforeEach(async () => {
    panel = await createTestPanel();
    await setupAdmin(panel);
    svc = new MacrosService({ db: panel.ctx.db, now: () => 1_700_000_000_000 });
    userId = panel.ctx.db.select().from(users).all()[0]?.id ?? '';
    // Un vrai serveur : les macros rattachées à un serveur ont une clé étrangère.
    const machine = panel.ctx.machines.create('pc');
    serverId = 'srv-a';
    panel.ctx.db
      .insert(servers)
      .values({
        id: serverId,
        machineId: machine.id,
        name: 'Survie',
        path: 'E:/srv',
        loader: 'vanilla',
        provisioning: 'ready',
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
  });
  afterEach(async () => {
    await panel.close();
  });

  it('crée, liste, modifie et supprime', () => {
    const created = svc.create({ name: '  Redémarrage  ', commands: '/say bye\nstop' }, userId);
    expect(created.name).toBe('Redémarrage');
    expect(created.commands).toEqual(['say bye', 'stop']);
    expect(created.destructive).toBe(true);
    // Sans serveur précisé, la macro vaut pour toute la flotte — le cas normal.
    expect(created.serverId).toBeNull();

    const updated = svc.update(created.id, { name: 'Annonce', commands: 'say bonjour' });
    expect(updated.commands).toEqual(['say bonjour']);
    expect(updated.destructive).toBe(false);

    expect(svc.list().map((m) => m.name)).toEqual(['Annonce']);
    svc.remove(created.id);
    expect(svc.list()).toEqual([]);
    expect(() => svc.get(created.id)).toThrow();
  });

  it('ne montre à un serveur que les macros globales et les siennes', () => {
    svc.create({ name: 'Globale', commands: 'list' }, userId);
    svc.create({ name: 'Locale', commands: 'list', serverId }, userId);
    expect(svc.list(serverId).map((m) => m.name)).toEqual(['Globale', 'Locale']);
    expect(svc.list('srv-inconnu').map((m) => m.name)).toEqual(['Globale']);
  });

  it('refuse une macro vide ou démesurée', () => {
    expect(() => svc.create({ name: 'vide', commands: '\n  \n' }, userId)).toThrow(
      /at least one command/,
    );
    const tooMany = Array.from({ length: 21 }, (_, i) => `say ${String(i)}`).join('\n');
    expect(() => svc.create({ name: 'trop', commands: tooMany }, userId)).toThrow(/too many/);
  });

  it('exécute dans l’ordre et s’arrête au premier échec', async () => {
    const macro = svc.create(
      { name: 'Sauvegarde', commands: 'save-off\nsave-all flush\nsave-on' },
      userId,
    );
    const send = vi
      .fn<(serverId: string, command: string) => Promise<{ via: 'stdin' | 'rcon' }>>()
      .mockResolvedValueOnce({ via: 'rcon' })
      .mockRejectedValueOnce(new ProtocolError('E_CONFLICT', 'server not running'));

    const result = await svc.run(macro.id, serverId, send);
    // La troisième n'est même pas tentée : la séquence a un sens, pas les commandes isolées.
    expect(send).toHaveBeenCalledTimes(2);
    expect(result.results).toMatchObject([
      { command: 'save-off', ok: true, via: 'rcon' },
      { command: 'save-all flush', ok: false, error: 'E_CONFLICT' },
    ]);
  });

  it('conserve le vrai code d’erreur, y compris celui du panel', async () => {
    const macro = svc.create({ name: 'Liste', commands: 'list' }, userId);
    // Machine hors ligne : c'est une `AppError` du panel, pas une `ProtocolError` d'agent.
    // Elle ressortait en « erreur interne », ce qui est faux et inexploitable.
    const offline = () => Promise.reject(agentOffline('m1'));
    const result = await svc.run(macro.id, serverId, offline);
    expect(result.results[0]).toMatchObject({ ok: false, error: 'E_AGENT_OFFLINE' });
    expect(result.results[0]?.message).toBeTruthy();
  });

  it('refuse une macro rattachée à un serveur qui n’existe pas', () => {
    // Sans ce contrôle, la clé étrangère sortait en SqliteError brute, masquée en 500.
    expect(() =>
      svc.create({ name: 'fantôme', commands: 'list', serverId: 'srv-absent' }, userId),
    ).toThrow(/not found/i);
    const macro = svc.create({ name: 'ok', commands: 'list' }, userId);
    expect(() =>
      svc.update(macro.id, { name: 'ok', commands: 'list', serverId: 'srv-absent' }),
    ).toThrow(/not found/i);
  });

  it('refuse de jouer la macro d’un autre serveur', async () => {
    const macro = svc.create({ name: 'locale', commands: 'list', serverId }, userId);
    const send = () => Promise.resolve<{ via: 'stdin' | 'rcon' }>({ via: 'rcon' });
    await expect(svc.run(macro.id, 'srv-autre', send)).rejects.toThrow(/another server/);
    await expect(svc.run(macro.id, serverId, send)).resolves.toMatchObject({
      results: [{ command: 'list', ok: true }],
    });
  });
});
