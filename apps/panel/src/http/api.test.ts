import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { assertListenHost } from '../config.js';
import { runMaintenance } from '../app.js';
import {
  cookieFrom,
  createTestPanel,
  createUser,
  login,
  setupAdmin,
  type TestPanel,
} from '../test/helpers.js';

describe('panel — API, auth, RBAC, migrations', () => {
  let panel: TestPanel;

  beforeEach(async () => {
    panel = await createTestPanel();
  });
  afterEach(async () => {
    await panel.close();
  });

  it('rejoue les migrations from scratch (mmo.db + metrics.db) avec les PRAGMAs attendus', () => {
    const tables = panel.ctx.sqlite
      .prepare("select name from sqlite_master where type='table' order by name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    for (const expected of [
      'users',
      'sessions',
      'machines',
      'pairing_codes',
      'watched_directories',
      'servers',
      'players',
      'player_sessions',
      'events',
      'audit_log',
      'app_settings',
      'processed_events',
      'tasks',
      'backups',
    ]) {
      expect(names).toContain(expected);
    }
    expect(panel.ctx.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    // COLLATE NOCASE posé à la main dans la migration : l'unicité est insensible à la casse.
    const usersDdl = panel.ctx.sqlite
      .prepare("select sql from sqlite_master where name='users'")
      .get() as { sql: string };
    expect(usersDdl.sql).toContain('COLLATE NOCASE');
    const metricsTables = panel.ctx.metrics
      .all<{ name: string }>(sql`select name from sqlite_master where type='table' order by name`)
      .map((t) => t.name);
    expect(metricsTables).toEqual(
      expect.arrayContaining([
        'metrics_server_raw',
        'metrics_machine_raw',
        'metrics_server_1m',
        'metrics_server_1h',
      ]),
    );
  });

  it('refuse 0.0.0.0 et :: comme adresse d’écoute', () => {
    expect(() => {
      assertListenHost('0.0.0.0');
    }).toThrow(/never binds all interfaces/);
    expect(() => {
      assertListenHost('::');
    }).toThrow();
    expect(() => {
      assertListenHost('127.0.0.1');
    }).not.toThrow();
  });

  it('wizard first-run : statut, création admin (verrouillée ensuite), VAPID, session', async () => {
    let res = await panel.app.inject({ method: 'GET', url: '/api/setup/status' });
    expect(res.json()).toEqual({ needsSetup: true });
    res = await panel.app.inject({ method: 'GET', url: '/api/machines' });
    expect(res.statusCode).toBe(401);
    // Phase 12 : le pourcent-encodage du préfixe ne contourne ni l'auth ni le RBAC (le routeur
    // décode avant de router, le hook décidait sur l'URL brute).
    for (const url of ['/%61pi/machines', '/%61pi/settings', '/%2Fapi/users', '/ws%2Fclient']) {
      res = await panel.app.inject({ method: 'GET', url });
      if (url.startsWith('/%61pi')) expect(res.statusCode, url).toBe(401);
      expect(res.body, url).not.toMatch(/"(?:machines|settings|users)"\s*:/);
    }
    expect(res.json<{ details: { setupRequired: boolean } }>().details.setupRequired).toBe(true);

    res = await panel.app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { username: 'Admin', password: 'short' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ code: string }>().code).toBe('E_VALIDATION');

    // URL publique invalide : rejet AVANT toute écriture (le compte ne doit pas être créé).
    res = await panel.app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: {
        username: 'Admin',
        password: 'correct horse battery',
        locale: 'en',
        publicUrl: 'https://panel.example/un/chemin',
        accessMode: 'tailscale',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ code: string }>().code).toBe('E_VALIDATION');
    expect((await panel.app.inject({ method: 'GET', url: '/api/setup/status' })).json()).toEqual({
      needsSetup: true,
    });

    // Même identifiant, URL sans schéma : https:// est supposé (tolérance de saisie).
    res = await panel.app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: {
        username: 'Admin',
        password: 'correct horse battery',
        locale: 'en',
        publicUrl: 'panel.example/',
        accessMode: 'tailscale',
      },
    });
    expect(res.statusCode).toBe(201);
    const cookie = cookieFrom(res);
    expect(cookie).toMatch(/^mmo_session=/);
    expect(String(res.headers['set-cookie'])).toContain('HttpOnly');
    expect(String(res.headers['set-cookie'])).toContain('Secure');
    expect(panel.ctx.settings.get('push.vapidPublicKey')).toMatch(/^B[A-Za-z0-9_-]{86}$/);
    expect(panel.ctx.settings.public()['panel.publicUrl']).toBe('https://panel.example');
    expect(panel.ctx.settings.public()).not.toHaveProperty('push.vapidPrivateKey');

    res = await panel.app.inject({ method: 'GET', url: '/api/setup/status' });
    expect(res.json()).toEqual({ needsSetup: false });
    res = await panel.app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { username: 'evil', password: 'correct horse battery' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ code: string }>().code).toBe('E_SETUP_DONE');

    res = await panel.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(
      res.json<{ user: { username: string; role: string; locale: string } }>().user,
    ).toMatchObject({
      username: 'Admin',
      role: 'admin',
      locale: 'en',
    });
  });

  it('login insensible à la casse, mauvais mot de passe, logout, session expirée, rate-limit', async () => {
    await setupAdmin(panel, { username: 'Admin', password: 'correct horse battery' });
    const cookie = await login(panel, 'ADMIN', 'correct horse battery');
    let res = await panel.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(res.statusCode).toBe(200);

    res = await panel.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'wrong' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json<{ code: string }>().code).toBe('E_AUTH');

    res = await panel.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    res = await panel.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(res.statusCode).toBe(401);

    const cookie2 = await login(panel, 'admin', 'correct horse battery');
    panel.clock.advance(31 * 24 * 3_600_000);
    res = await panel.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: cookie2 },
    });
    expect(res.statusCode).toBe(401);
    runMaintenance(panel.ctx);
    expect(panel.ctx.sessions.purgeExpired()).toBe(0);

    for (let i = 0; i < 10; i++) {
      await panel.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'admin', password: 'wrong' },
      });
    }
    res = await panel.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'correct horse battery' },
    });
    expect(res.statusCode).toBe(429);
    expect(res.json<{ code: string }>().code).toBe('E_RATE_LIMITED');
  });

  it('RBAC : viewer lit, operator agit, admin administre ; dernier admin protégé ; hash argon2id', async () => {
    const admin = await setupAdmin(panel);
    const operator = await createUser(panel, admin, {
      username: 'op',
      password: 'operator-pass',
      role: 'operator',
    });
    const viewer = await createUser(panel, admin, {
      username: 'view',
      password: 'viewer-pass!',
      role: 'viewer',
    });

    expect(panel.ctx.users.findByUsername('op')?.passwordHash).toMatch(/^\$argon2id\$/);

    const get = (url: string, cookie: string) =>
      panel.app.inject({ method: 'GET', url, headers: { cookie } });
    expect((await get('/api/servers', viewer)).statusCode).toBe(200);
    expect((await get('/api/users', viewer)).statusCode).toBe(403);
    expect((await get('/api/users', operator)).statusCode).toBe(403);
    expect((await get('/api/users', admin)).statusCode).toBe(200);
    expect((await get('/api/audit', admin)).statusCode).toBe(200);

    let res = await panel.app.inject({
      method: 'POST',
      url: '/api/machines',
      payload: { name: 'PC' },
      headers: { cookie: operator },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ code: string }>().code).toBe('E_FORBIDDEN');
    res = await panel.app.inject({
      method: 'POST',
      url: '/api/machines',
      payload: { name: 'PC' },
      headers: { cookie: admin },
    });
    expect(res.statusCode).toBe(201);
    const machineId = res.json<{ machine: { id: string } }>().machine.id;
    // Opérateur : action serveur autorisée (agent hors ligne → 503 E_AGENT_OFFLINE, pas 403).
    res = await panel.app.inject({
      method: 'POST',
      url: `/api/machines/${machineId}/scan`,
      payload: {},
      headers: { cookie: operator },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json<{ code: string }>().code).toBe('E_AGENT_OFFLINE');
    res = await panel.app.inject({
      method: 'POST',
      url: `/api/machines/${machineId}/scan`,
      payload: {},
      headers: { cookie: viewer },
    });
    expect(res.statusCode).toBe(403);

    // Dernier admin : ni rétrogradable ni supprimable, même par lui-même.
    const adminId = panel.ctx.users.findByUsername('admin')!.id;
    res = await panel.app.inject({
      method: 'PATCH',
      url: `/api/users/${adminId}`,
      payload: { role: 'viewer' },
      headers: { cookie: admin },
    });
    expect(res.statusCode).toBe(409);
    res = await panel.app.inject({
      method: 'DELETE',
      url: `/api/users/${adminId}`,
      headers: { cookie: admin },
    });
    expect(res.statusCode).toBe(409);

    // Désactivation d'un utilisateur : sessions révoquées.
    const opId = panel.ctx.users.findByUsername('op')!.id;
    res = await panel.app.inject({
      method: 'PATCH',
      url: `/api/users/${opId}`,
      payload: { isActive: false },
      headers: { cookie: admin },
    });
    expect(res.statusCode).toBe(200);
    expect((await get('/api/servers', operator)).statusCode).toBe(401);

    // Doublon de nom (insensible à la casse).
    res = await panel.app.inject({
      method: 'POST',
      url: '/api/users',
      payload: { username: 'VIEW', password: 'another-pass', role: 'viewer' },
      headers: { cookie: admin },
    });
    expect(res.statusCode).toBe(409);

    // Audit : création/désactivation tracées avec le nom dénormalisé.
    const audit = panel.ctx.audit.list();
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining([
        'setup.completed',
        'user.created',
        'user.updated',
        'machine.created',
      ]),
    );
    expect(audit.find((a) => a.action === 'machine.created')?.username).toBe('admin');
  });

  it('machines : création + code d’appairage, one-liners, renommage, désactivation, suppression', async () => {
    const admin = await setupAdmin(panel);
    await panel.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      payload: { 'panel.publicUrl': 'https://mmo.example' },
      headers: { cookie: admin },
    });
    let res = await panel.app.inject({
      method: 'POST',
      url: '/api/machines',
      payload: { name: 'Tour' },
      headers: { cookie: admin },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{
      machine: { id: string; status: string };
      pairing: { code: string; expiresAt: number; install: { windows: string; unix: string } };
    }>();
    expect(body.machine.status).toBe('pending');
    expect(body.pairing.code).toMatch(/^MMOP-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(body.pairing.expiresAt).toBe(panel.clock.now() + 15 * 60_000);
    expect(body.pairing.install.unix).toContain('https://mmo.example/install.sh');
    expect(body.pairing.install.windows).toContain(body.pairing.code);
    // Jamais le code en clair en base.
    const rows = panel.ctx.sqlite.prepare('select code_hash from pairing_codes').all() as {
      code_hash: string;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.code_hash).not.toContain(body.pairing.code.slice(5, 9));

    res = await panel.app.inject({
      method: 'POST',
      url: '/api/machines',
      payload: { name: 'Tour' },
      headers: { cookie: admin },
    });
    expect(res.statusCode).toBe(409);

    res = await panel.app.inject({
      method: 'PATCH',
      url: `/api/machines/${body.machine.id}`,
      payload: { name: 'Tour 2', disabled: true },
      headers: { cookie: admin },
    });
    expect(res.json<{ machine: { name: string; status: string } }>().machine).toMatchObject({
      name: 'Tour 2',
      status: 'disabled',
    });
    res = await panel.app.inject({
      method: 'PATCH',
      url: `/api/machines/${body.machine.id}`,
      payload: { disabled: false },
      headers: { cookie: admin },
    });
    expect(res.json<{ machine: { status: string } }>().machine.status).toBe('pending');

    res = await panel.app.inject({
      method: 'DELETE',
      url: `/api/machines/${body.machine.id}`,
      headers: { cookie: admin },
    });
    expect(res.statusCode).toBe(204);
    res = await panel.app.inject({
      method: 'GET',
      url: `/api/machines/${body.machine.id}`,
      headers: { cookie: admin },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ code: string }>().code).toBe('E_NOT_FOUND');
  });

  it('événements et réglages : liste filtrée, clés éditables seulement', async () => {
    const admin = await setupAdmin(panel);
    panel.ctx.events.publish({ type: 'test.one', serverId: 's1' });
    panel.ctx.events.publish({
      type: 'test.two',
      serverId: 's2',
      severity: 'warning',
      payload: { a: 1 },
    });
    let res = await panel.app.inject({
      method: 'GET',
      url: '/api/events?serverId=s2',
      headers: { cookie: admin },
    });
    expect(res.json<{ events: { type: string; payload: unknown }[] }>().events).toEqual([
      expect.objectContaining({ type: 'test.two', payload: { a: 1 } }),
    ]);
    res = await panel.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      payload: { 'push.vapidPrivateKey': 'hack' },
      headers: { cookie: admin },
    });
    expect(res.statusCode).toBe(400);
    res = await panel.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      payload: { 'agents.restoreOnBoot': 'false', 'metrics.intervalSec': '30' },
      headers: { cookie: admin },
    });
    expect(res.statusCode).toBe(200);
    expect(panel.ctx.settings.getBool('agents.restoreOnBoot')).toBe(false);
    expect(panel.ctx.settings.getInt('metrics.intervalSec', 15)).toBe(30);
  });
});
