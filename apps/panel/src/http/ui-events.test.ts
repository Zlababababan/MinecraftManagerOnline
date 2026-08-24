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
