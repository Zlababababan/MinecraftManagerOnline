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
  let logError: ReturnType<typeof vi.fn<(obj: object, msg: string) => void>>;

  beforeEach(async () => {
    panel = await createTestPanel();
    await setupAdmin(panel);
    logError = vi.fn<(obj: object, msg: string) => void>();
    svc = new MacrosService({
      db: panel.ctx.db,
      now: () => 1_700_000_000_000,
      logger: { error: logError },
    });
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

    const result = await svc.run(macro, serverId, send);
    // La troisième n'est même pas tentée : la séquence a un sens, pas les commandes isolées.
    expect(send).toHaveBeenCalledTimes(2);
    expect(result.results).toMatchObject([
      { command: 'save-off', ok: true, via: 'rcon' },
      { command: 'save-all flush', ok: false, error: 'E_CONFLICT' },
    ]);
    // Le total dit la longueur réelle de la séquence : le client peut avoir une liste en retard.
    expect(result.total).toBe(3);
  });

  it('conserve le vrai code d’erreur, y compris celui du panel', async () => {
    const macro = svc.create({ name: 'Liste', commands: 'list' }, userId);
    // Machine hors ligne : c'est une `AppError` du panel, pas une `ProtocolError` d'agent.
    // Elle ressortait en « erreur interne », ce qui est faux et inexploitable.
    const offline = () => Promise.reject(agentOffline('m1'));
    const result = await svc.run(macro, serverId, offline);
    expect(result.results[0]).toMatchObject({ ok: false, error: 'E_AGENT_OFFLINE' });
    expect(result.results[0]?.message).toBeTruthy();
  });

  it('masque le message d’une exception inattendue du panel, et la journalise', async () => {
    // Même politique que le gestionnaire HTTP : une SqliteError (disque plein…) survenue dans le
    // chemin d'envoi ne doit pas sortir en clair dans une réponse 200 — elle contournerait le
    // masquage des 5xx. Le texte brut part au journal, le client reçoit un libellé générique.
    const macro = svc.create({ name: 'Liste', commands: 'list' }, userId);
    const boom = () => Promise.reject(new Error('SQLITE_FULL: database or disk is full at E:/x'));
    const result = await svc.run(macro, serverId, boom);
    expect(result.results[0]).toMatchObject({
      ok: false,
      error: 'E_INTERNAL',
      message: 'internal error',
    });
    expect(logError).toHaveBeenCalledOnce();
    // Une E_INTERNAL écrite par l'AGENT est du vocabulaire produit : elle traverse, comme en HTTP.
    const agentSaid = () => Promise.reject(new ProtocolError('E_INTERNAL', 'agent said why'));
    const viaAgent = await svc.run(macro, serverId, agentSaid);
    expect(viaAgent.results[0]?.message).toBe('agent said why');
  });

  it('refuse un nom fait uniquement d’espaces', () => {
    // Trimé à l'écriture, il deviendrait un bouton sans libellé dans la barre.
    expect(() => svc.create({ name: '   ', commands: 'list' }, userId)).toThrow(/needs a name/);
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
    await expect(svc.run(macro, 'srv-autre', send)).rejects.toThrow(/another server/);
    await expect(svc.run(macro, serverId, send)).resolves.toMatchObject({
      results: [{ command: 'list', ok: true }],
    });
  });
});

describe('routes des macros — le garde-fou de confirmation est un contrat HTTP', () => {
  let panel: TestPanel;
  let cookie: string;
  let serverId: string;

  beforeEach(async () => {
    panel = await createTestPanel();
    cookie = await setupAdmin(panel);
    const machine = panel.ctx.machines.create('pc');
    serverId = 'srv-r';
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

  const createMacro = async (commands: string) => {
    const res = await panel.app.inject({
      method: 'POST',
      url: '/api/macros',
      payload: { name: 'Arrêt', commands },
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    return res.json<{ macro: { id: string; updatedAt: number; commands: string[] } }>().macro;
  };
  const runMacro = (macroId: string, body: Record<string, unknown>) =>
    panel.app.inject({
      method: 'POST',
      url: `/api/servers/${serverId}/macros/${macroId}/run`,
      payload: body,
      headers: { cookie },
    });

  it('refuse une macro destructrice sans confirmation — avec la séquence et sa version', async () => {
    const macro = await createMacro('say bye\nstop');
    const res = await runMacro(macro.id, {});
    expect(res.statusCode).toBe(409);
    const body = res.json<{
      code: string;
      details: { reason: string; commands: string[]; updatedAt: number };
    }>();
    expect(body.code).toBe('E_CONFLICT');
    expect(body.details).toMatchObject({
      reason: 'confirm_required',
      commands: ['say bye', 'stop'],
      updatedAt: macro.updatedAt,
    });
  });

  it('refuse une confirmation qui approuve une version périmée de la séquence', async () => {
    const macro = await createMacro('stop');
    // Modification concurrente (autre onglet, autre opérateur) : la séquence change.
    panel.clock.set(panel.ctx.now() + 60_000);
    const updated = await panel.app.inject({
      method: 'PUT',
      url: `/api/macros/${macro.id}`,
      payload: { name: 'Arrêt', commands: 'ban griefer' },
      headers: { cookie },
    });
    expect(updated.statusCode).toBe(200);
    const res = await runMacro(macro.id, { confirmDestructive: true, approvedAt: macro.updatedAt });
    expect(res.statusCode).toBe(409);
    const details = res.json<{ details: { commands: string[]; updatedAt: number } }>().details;
    // Le refus renvoie la séquence FRAÎCHE : c'est elle que le prochain modal montrera.
    expect(details.commands).toEqual(['ban griefer']);
    expect(details.updatedAt).toBeGreaterThan(macro.updatedAt);
  });

  it('exécute la version approuvée — et un échec d’agent garde son vrai code', async () => {
    const macro = await createMacro('stop');
    const res = await runMacro(macro.id, { confirmDestructive: true, approvedAt: macro.updatedAt });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ results: { error?: string; message?: string }[]; total: number }>();
    // Aucun agent connecté dans ce test : la première commande échoue, avec son vrai code.
    expect(body.results[0]?.error).toBe('E_AGENT_OFFLINE');
    expect(body.total).toBe(1);
  });

  it('une macro sans danger part sans confirmation', async () => {
    const macro = await createMacro('list');
    const res = await runMacro(macro.id, {});
    expect(res.statusCode).toBe(200);
  });
});
