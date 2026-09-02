/**
 * Lot 9 — journal d'accès corrélé et `/api/health` diagnostique : une ligne par réponse API avec
 * l'identifiant de requête (celui qu'un 500 renvoie), sans query string, avec l'utilisateur ; le
 * diagnostic de santé réservé aux administrateurs.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runMaintenance } from '../services/maintenance.js';
import { createTestPanel, createUser, setupAdmin, type TestPanel } from '../test/helpers.js';
import { isLoggedPath } from './access-log.js';

interface AccessLine {
  level: number;
  msg: string;
  requestId?: string;
  method?: string;
  route?: string;
  status?: number;
  durationMs?: number;
  user?: string;
  ip?: string;
}

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

describe('journal d’accès et /api/health diagnostique', () => {
  const panels: TestPanel[] = [];
  afterEach(async () => {
    for (const p of panels.splice(0)) await p.close();
  });

  async function openPanel(slowMs?: number): Promise<{ panel: TestPanel; lines: string[] }> {
    const lines: string[] = [];
    const panel = await createTestPanel({
      logger: {
        level: 'debug',
        stream: {
          write: (chunk: string) => {
            lines.push(chunk);
          },
        },
      },
      ...(slowMs === undefined ? {} : { accessLog: { slowMs } }),
    });
    panels.push(panel);
    return { panel, lines };
  }
  const requests = (lines: string[]): AccessLine[] =>
    lines.map((l) => JSON.parse(l) as AccessLine).filter((r) => r.msg === 'request');

  it('une ligne par réponse : ULID, méthode, motif de route sans query string, statut, durée, utilisateur', async () => {
    const { panel, lines } = await openPanel();
    const admin = await setupAdmin(panel);
    lines.length = 0;

    await panel.app.inject({
      method: 'GET',
      url: '/api/events?limit=5&type=machine.online',
      headers: { cookie: admin },
    });
    await panel.app.inject({ method: 'GET', url: '/api/servers/nope', headers: { cookie: admin } });
    const anonymous = await panel.app.inject({ method: 'GET', url: '/api/settings' });
    expect(anonymous.statusCode).toBe(401);

    const got = requests(lines);
    expect(got).toHaveLength(3);
    expect(got[0]).toMatchObject({
      level: 30,
      method: 'GET',
      route: '/api/events',
      status: 200,
      user: 'admin',
      ip: '127.0.0.1',
    });
    expect(got[0]?.requestId).toMatch(ULID);
    expect(got[0]?.durationMs).toBeTypeOf('number');
    expect(JSON.stringify(got[0])).not.toContain('limit=5');
    // Motif de route, pas l'URL : l'identifiant du serveur n'est pas dans le journal.
    expect(got[1]).toMatchObject({ route: '/api/servers/:id', status: 404, user: 'admin' });
    // Refus d'authentification : journalisé sans utilisateur.
    expect(got[2]).toMatchObject({ route: '/api/settings', status: 401 });
    expect(got[2]?.user).toBeUndefined();
    // Trois requêtes, trois identifiants distincts.
    expect(new Set(got.map((r) => r.requestId)).size).toBe(3);
  });

  it('la sonde de santé anonyme reste en debug ; une réponse lente ou un 500 passent en warn', async () => {
    const { panel, lines } = await openPanel(0);
    await panel.app.inject({ method: 'GET', url: '/api/health' });
    // slowMs = 0 : toute requête est « lente », donc warn (40) même pour la sonde.
    expect(requests(lines).at(-1)).toMatchObject({ route: '/api/health', level: 40 });

    const strict = await openPanel();
    await strict.panel.app.inject({ method: 'GET', url: '/api/health' });
    expect(requests(strict.lines).at(-1)).toMatchObject({ route: '/api/health', level: 20 });
    // Le front n'est pas journalisé, la surface API/distribution l'est.
    expect(isLoggedPath('/assets/index-abc.js')).toBe(false);
    expect(isLoggedPath('/')).toBe(false);
    expect(isLoggedPath('/api/servers')).toBe(true);
    expect(isLoggedPath('/dist/agent.tar.gz')).toBe(true);
    expect(isLoggedPath('/install.sh')).toBe(true);
  });

  it('un 500 renvoie le requestId de sa ligne de journal', async () => {
    const { panel, lines } = await openPanel();
    const admin = await setupAdmin(panel);
    // Une exception inattendue du panel (pas une erreur produit) sur une vraie route.
    vi.spyOn(panel.ctx.events, 'list').mockImplementation(() => {
      throw new TypeError('boom');
    });
    const res = await panel.app.inject({
      method: 'GET',
      url: '/api/events',
      headers: { cookie: admin },
    });
    expect(res.statusCode).toBe(500);
    const { message, details } = res.json<{ message: string; details: { requestId: string } }>();
    expect(message).toBe('internal error');
    expect(details.requestId).toMatch(ULID);
    const line = requests(lines).find((r) => r.route === '/api/events');
    expect(line).toMatchObject({ level: 40, status: 500, requestId: details.requestId });
  });

  it('/api/health : sonde publique inchangée, diagnostic pour les administrateurs seulement', async () => {
    const { panel } = await openPanel();
    const admin = await setupAdmin(panel);
    const viewer = await createUser(panel, admin, {
      username: 'viewer',
      password: 'viewer-pass',
      role: 'viewer',
    });
    const anonymous = await panel.app.inject({ method: 'GET', url: '/api/health' });
    expect(anonymous.statusCode).toBe(200);
    expect(anonymous.json<Record<string, unknown>>()).not.toHaveProperty('diagnostics');
    const asViewer = await panel.app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { cookie: viewer },
    });
    expect(asViewer.json<Record<string, unknown>>()).not.toHaveProperty('diagnostics');

    panel.clock.advance(90_000);
    runMaintenance(panel.ctx);
    const asAdmin = await panel.app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { cookie: admin },
    });
    const { diagnostics } = asAdmin.json<{
      diagnostics: {
        startedAt: number;
        uptimeSec: number;
        logFile: string | null;
        machines: { total: number; connected: number };
        databases: { mmo: { file: string; bytes: number } };
        maintenance: { at: number; purged: Record<string, number>; vacuum: unknown[] } | null;
      };
    }>();
    expect(diagnostics.uptimeSec).toBe(90);
    expect(diagnostics.logFile).toBeNull();
    expect(diagnostics.machines).toEqual({ total: 0, connected: 0 });
    expect(diagnostics.databases.mmo).toEqual({ file: ':memory:', bytes: 0 });
    expect(diagnostics.maintenance?.at).toBe(panel.clock.now());
    expect(diagnostics.maintenance?.purged).toEqual({});
    expect(diagnostics.maintenance?.vacuum).toHaveLength(2);
  });
});
