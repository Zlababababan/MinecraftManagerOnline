/** Parcours UI : ingestion par lots, lecture admin seulement, purge par rétention. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runMaintenance } from '../app.js';
import { createTestPanel, createUser, setupAdmin, type TestPanel } from '../test/helpers.js';

describe('ui-events', () => {
  let panel: TestPanel;
  let admin: string;

  beforeEach(async () => {
    panel = await createTestPanel();
    admin = await setupAdmin(panel);
  });

  afterEach(async () => {
    await panel.close();
  });

  it('enregistre un lot, le restitue aux admins, refuse les autres rôles en lecture', async () => {
    const viewer = await createUser(panel, admin, {
      username: 'lecteur',
      password: 'correct horse battery',
      role: 'viewer',
    });
    const t = panel.clock.now();
    const post = await panel.app.inject({
      method: 'POST',
      url: '/api/ui-events',
      headers: { cookie: viewer },
      payload: {
        events: [
          { ts: t, kind: 'nav', page: '/servers/s1' },
          { ts: t + 1000, kind: 'click', page: '/servers/s1', target: 'action-start' },
        ],
      },
    });
    expect(post.statusCode).toBe(204);

    const denied = await panel.app.inject({
      method: 'GET',
      url: '/api/ui-events',
      headers: { cookie: viewer },
    });
    expect(denied.statusCode).toBe(403);

    const res = await panel.app.inject({
      method: 'GET',
      url: '/api/ui-events',
      headers: { cookie: admin },
    });
    expect(res.statusCode).toBe(200);
    const { events } = res.json<{
      events: { kind: string; page: string; target?: string; username: string | null }[];
    }>();
    // Ordre antéchronologique, utilisateur attaché côté serveur.
    expect(events.map((e) => e.kind)).toEqual(['click', 'nav']);
    expect(events[0]).toMatchObject({ target: 'action-start', username: 'lecteur' });
  });

  it('garde le détail de chaque interaction (clic dans le vide, souris, saisie, message) et le restitue', async () => {
    const t = panel.clock.now();
    const sent = [
      { ts: t, kind: 'click', page: '/servers', data: { x: 412, y: 77, void: true, tag: 'div' } },
      { ts: t + 1, kind: 'move', page: '/servers', data: { x: 500, y: 90 } },
      {
        ts: t + 2,
        kind: 'input',
        page: '/servers/s1',
        target: 'prop-query.port',
        data: { value: '25570' },
      },
      {
        ts: t + 3,
        kind: 'toast',
        page: '/servers/s1',
        data: { text: 'Le port 25565 est déjà utilisé.' },
      },
    ];
    const post = await panel.app.inject({
      method: 'POST',
      url: '/api/ui-events',
      headers: { cookie: admin },
      payload: { events: sent },
    });
    expect(post.statusCode).toBe(204);
    const res = await panel.app.inject({
      method: 'GET',
      url: '/api/ui-events',
      headers: { cookie: admin },
    });
    const { events } = res.json<{ events: { kind: string; data?: unknown; target?: string }[] }>();
    expect(events.map((e) => ({ kind: e.kind, data: e.data })).reverse()).toEqual(
      sent.map((e) => ({ kind: e.kind, data: e.data })),
    );
    // Un genre inconnu ou un détail démesuré est refusé : la table ne reçoit pas n'importe quoi.
    for (const bad of [
      { ts: t, kind: 'keylogger', page: '/' },
      { ts: t, kind: 'input', page: '/', data: { value: 'x'.repeat(501) } },
    ]) {
      const refused = await panel.app.inject({
        method: 'POST',
        url: '/api/ui-events',
        headers: { cookie: admin },
        payload: { events: [bad] },
      });
      expect(refused.statusCode).toBe(400);
    }
  });

  it('une action refusée entre dans l’audit ; une lecture refusée et le parcours UI n’y entrent pas', async () => {
    const viewer = await createUser(panel, admin, {
      username: 'lecteur',
      password: 'correct horse battery',
      role: 'viewer',
    });
    const actions = async (): Promise<{ action: string; username: string; details: unknown }[]> =>
      (
        await panel.app.inject({ method: 'GET', url: '/api/audit', headers: { cookie: admin } })
      ).json<{ audit: { action: string; username: string; details: unknown }[] }>().audit;
    const before = (await actions()).length;

    // Écriture interdite à un lecteur : refusée ET tracée.
    const patch = await panel.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: { cookie: viewer },
      payload: { 'retention.auditDays': '30' },
    });
    expect(patch.statusCode).toBe(403);
    const [last] = await actions();
    expect(last).toMatchObject({
      action: 'request.refused',
      username: 'lecteur',
      details: { method: 'PATCH', route: '/api/settings', status: 403, code: 'E_FORBIDDEN' },
    });

    // Lecture refusée et lot de parcours UI invalide : rien de plus dans l'audit.
    // (une route de lecture réservée aux administrateurs, autre que celle du parcours UI)
    const read = await panel.app.inject({
      method: 'GET',
      url: '/api/settings',
      headers: { cookie: viewer },
    });
    expect(read.statusCode).toBe(403);
    await panel.app.inject({
      method: 'POST',
      url: '/api/ui-events',
      headers: { cookie: admin },
      payload: { events: [] },
    });
    // Une écriture acceptée ne produit pas de « refus ».
    const ok = await panel.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: { cookie: admin },
      payload: { 'retention.auditDays': '30' },
    });
    expect(ok.statusCode).toBe(200);
    const after = await actions();
    expect(after.filter((a) => a.action === 'request.refused')).toHaveLength(1);
    expect(after.length).toBe(before + 2);
  });

  it('exige une session et un lot valide', async () => {
    const anonymous = await panel.app.inject({
      method: 'POST',
      url: '/api/ui-events',
      payload: { events: [{ ts: 1, kind: 'click', page: '/' }] },
    });
    expect(anonymous.statusCode).toBe(401);

    const empty = await panel.app.inject({
      method: 'POST',
      url: '/api/ui-events',
      headers: { cookie: admin },
      payload: { events: [] },
    });
    expect(empty.statusCode).toBe(400);
  });

  it('purge au-delà de la rétention (14 j par défaut)', () => {
    const t = panel.clock.now();
    panel.ctx.uiEvents.record({ userId: null, username: null }, [
      { ts: t, kind: 'click', page: '/', target: 'vieux' },
      { ts: t, kind: 'click', page: '/', target: 'recent' },
    ]);
    // Vieillit le premier événement au-delà de 14 jours.
    panel.ctx.metricsSqlite
      .prepare('UPDATE ui_events SET ts = ? WHERE target = ?')
      .run(t - 15 * 24 * 3_600_000, 'vieux');
    runMaintenance(panel.ctx);
    const targets = panel.ctx.uiEvents.list().map((e) => e.target);
    expect(targets).toEqual(['recent']);
  });
});
