/**
 * Lot 8 — clés d'API de bout en bout : création (jeton montré une fois, jamais audité, rôle
 * plafonné par le propriétaire, cap par compte), `Bearer` tenté sans cookie (le cookie prime, jamais
 * sur un WebSocket, jeton mal formé ou inconnu → 401, limiteur par adresse), rôle effectif = le plus
 * faible des deux (rétrogradation du propriétaire, désactivation, suppression en cascade), portées
 * d'un compte limité héritées et plafonnées par le rôle de la clé, routes réservées au cookie,
 * expiration puis purge, révocation (la sienne, celle d'un autre = 404, admin = tout).
 */
import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { API_KEY_PREFIX, MAX_API_KEYS_PER_USER, type ApiKeyDto } from '@mmo/protocol/client';

import { eq } from 'drizzle-orm';

import { apiKeys as apiKeysTable } from '../db/schema.js';
import { runMaintenance } from '../services/maintenance.js';
import { createTestPanel, createUser, login, setupAdmin, type TestPanel } from '../test/helpers.js';
import { EXPIRED_KEY_GRACE_MS } from '../services/api-keys.js';
import { BAD_API_KEY_LIMIT } from './auth.js';

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

interface Body {
  code?: string;
  details?: { reason?: string; max?: number };
}

const DAY = 86_400_000;

describe('lot 8 — clés d’API', () => {
  let panel: TestPanel;
  let admin: string;
  let op: string;
  let opId: string;
  let a: string;
  let b: string;

  const api = (
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    auth: { cookie?: string; bearer?: string },
    payload?: unknown,
  ) =>
    panel.app.inject({
      method,
      url,
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
      headers: {
        ...(auth.cookie === undefined ? {} : { cookie: auth.cookie }),
        ...(auth.bearer === undefined ? {} : { authorization: `Bearer ${auth.bearer}` }),
      },
    });

  async function createKey(
    cookie: string,
    body: { name: string; role?: string; expiresInDays?: number },
  ): Promise<{ key: ApiKeyDto; token: string }> {
    const res = await api('POST', '/api/api-keys', { cookie }, body);
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ key: ApiKeyDto; token: string }>();
  }

  async function keysOf(cookie: string, all = false): Promise<ApiKeyDto[]> {
    const res = await api('GET', `/api/api-keys${all ? '?all=true' : ''}`, { cookie });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{ keys: ApiKeyDto[] }>().keys;
  }

  beforeEach(async () => {
    panel = await createTestPanel();
    admin = await setupAdmin(panel);
    const m = await api('POST', '/api/machines', { cookie: admin }, { name: 'M1' });
    const machineId = m.json<{ machine: { id: string } }>().machine.id;
    a = (
      await panel.ctx.servers.adoptDetected(machineId, detected('/srv/a', 'A', 25565), undefined)
    ).server!.id;
    b = (
      await panel.ctx.servers.adoptDetected(machineId, detected('/srv/b', 'B', 25566), undefined)
    ).server!.id;
    op = await createUser(panel, admin, {
      username: 'op',
      password: 'correct horse battery',
      role: 'operator',
    });
    opId = panel.ctx.users.findByUsername('op')!.id;
  });

  afterEach(async () => {
    await panel.close();
  });

  it('création : jeton montré une fois, jamais audité, rôle plafonné, cap par compte', async () => {
    const { key, token } = await createKey(op, { name: 'script' });
    expect(token.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(token).toHaveLength(API_KEY_PREFIX.length + 43);
    expect(key.prefix).toBe(token.slice(0, API_KEY_PREFIX.length + 8));
    expect(key.role).toBe('viewer');
    expect(key.expiresAt).toBeNull();
    expect(key.username).toBe('op');

    const listed = await keysOf(op);
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(token.slice(API_KEY_PREFIX.length + 8));

    const audit = panel.ctx.audit.list(10).find((e) => e.action === 'apikey.created');
    expect(audit?.targetId).toBe(key.id);
    expect(audit?.username).toBe('op');
    expect(JSON.stringify(audit)).toContain(key.prefix);
    expect(JSON.stringify(audit)).not.toContain(token.slice(API_KEY_PREFIX.length + 8));

    // Un opérateur ne fabrique pas une clé admin ; une clé opérateur, oui.
    const above = await api('POST', '/api/api-keys', { cookie: op }, { name: 'x', role: 'admin' });
    expect(above.statusCode).toBe(400);
    expect(above.json<Body>().details?.reason).toBe('KEY_ABOVE_ROLE');
    expect((await createKey(op, { name: 'ops', role: 'operator' })).key.role).toBe('operator');

    for (let i = 2; i < MAX_API_KEYS_PER_USER; i++) await createKey(op, { name: `k${String(i)}` });
    const tooMany = await api('POST', '/api/api-keys', { cookie: op }, { name: 'one more' });
    expect(tooMany.statusCode).toBe(400);
    expect(tooMany.json<Body>().details).toMatchObject({
      reason: 'TOO_MANY_KEYS',
      max: MAX_API_KEYS_PER_USER,
    });
  });

  it('Bearer : sans cookie seulement, jamais sur un WebSocket, rôle = le plus faible, routes réservées au cookie', async () => {
    const viewerKey = (await createKey(op, { name: 'lecture' })).token;
    const operatorKey = (await createKey(op, { name: 'pilotage', role: 'operator' })).token;

    // Lecture par une clé viewer d'un opérateur : ça lit, ça n'agit pas.
    const list = await api('GET', '/api/servers', { bearer: viewerKey });
    expect(list.statusCode).toBe(200);
    const denied = await api(
      'POST',
      `/api/servers/${a}/start`,
      { bearer: viewerKey },
      {
        action: 'start',
      },
    );
    expect(denied.statusCode).toBe(403);
    const allowed = await api(
      'POST',
      `/api/servers/${a}/start`,
      { bearer: operatorKey },
      {
        action: 'start',
      },
    );
    expect([401, 403]).not.toContain(allowed.statusCode);

    // « Qui suis-je » rend le rôle EFFECTIF de la clé, pas celui du compte.
    const me = await api('GET', '/api/auth/me', { bearer: viewerKey });
    expect(me.statusCode).toBe(200);
    expect(me.json<{ user: { username: string; role: string } }>().user).toMatchObject({
      username: 'op',
      role: 'viewer',
    });

    // Dernière utilisation notée (adresse comprise).
    const used = (await keysOf(op)).find((k) => k.name === 'lecture');
    expect(used?.lastUsedAt).toBe(panel.clock.now());
    expect(used?.lastUsedIp).toBe('127.0.0.1');

    // Jeton inconnu, jeton mal formé : 401 nommé. Cookie présent : le cookie prime, le Bearer est ignoré.
    const unknown = await api('GET', '/api/servers', {
      bearer: `${API_KEY_PREFIX}${'A'.repeat(43)}`,
    });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json<Body>().details?.reason).toBe('INVALID_API_KEY');
    const malformed = await api('GET', '/api/servers', { bearer: 'hello' });
    expect(malformed.statusCode).toBe(401);
    const both = await api('GET', '/api/servers', { cookie: op, bearer: 'hello' });
    expect(both.statusCode).toBe(200);

    // Une clé ne gère ni compte, ni comptes, ni clés : ces routes exigent le cookie.
    for (const [method, url, payload] of [
      ['POST', '/api/api-keys', { name: 'boot' }],
      ['GET', '/api/api-keys', undefined],
      ['PATCH', '/api/auth/me', { locale: 'en' }],
      ['GET', '/api/users', undefined],
    ] as const) {
      const res = await api(method, url, { bearer: operatorKey }, payload);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json<Body>().details?.reason, `${method} ${url}`).toBe('API_KEY');
    }
    // Même une clé admin : `/api/users` reste réservé au cookie.
    const adminKey = (await createKey(admin, { name: 'root', role: 'admin' })).token;
    expect((await api('GET', '/api/users', { bearer: adminKey })).statusCode).toBe(403);
    expect((await api('GET', '/api/settings', { bearer: adminKey })).statusCode).toBe(200);

    // WebSocket navigateur : cookie seulement.
    await panel.listen();
    const wsStatus = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(`${panel.wsUrl}/ws/client`, {
        headers: { authorization: `Bearer ${operatorKey}` },
      });
      ws.once('unexpected-response', (_req, res) => {
        resolve(res.statusCode ?? 0);
        ws.terminate();
      });
      ws.once('open', () => {
        ws.close();
        reject(new Error('WebSocket ouvert par une clé d’API'));
      });
      ws.once('error', reject);
    });
    expect(wsStatus).toBe(401);
  });

  it('limiteur : trop de jetons refusés depuis une adresse → 429, même pour un bon jeton', async () => {
    const good = (await createKey(op, { name: 'ok' })).token;
    const bad = `${API_KEY_PREFIX}${'B'.repeat(43)}`;
    for (let i = 0; i < BAD_API_KEY_LIMIT.max; i++) {
      expect((await api('GET', '/api/servers', { bearer: bad })).statusCode).toBe(401);
    }
    const blocked = await api('GET', '/api/servers', { bearer: bad });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json<Body>().code).toBe('E_RATE_LIMITED');
    expect((await api('GET', '/api/servers', { bearer: good })).statusCode).toBe(429);
    panel.clock.advance(BAD_API_KEY_LIMIT.windowMs + 1);
    expect((await api('GET', '/api/servers', { bearer: good })).statusCode).toBe(200);
  });

  it('propriétaire rétrogradé, désactivé, supprimé : la clé suit, jamais au-dessus', async () => {
    const operatorKey = (await createKey(op, { name: 'pilotage', role: 'operator' })).token;
    const ok = await api(
      'POST',
      `/api/servers/${a}/start`,
      { bearer: operatorKey },
      {
        action: 'start',
      },
    );
    expect([401, 403]).not.toContain(ok.statusCode);

    // Rétrogradé en lecteur : la clé opérateur agit en lecteur, et la liste le dit.
    expect(
      (await api('PATCH', `/api/users/${opId}`, { cookie: admin }, { role: 'viewer' })).statusCode,
    ).toBe(200);
    const denied = await api(
      'POST',
      `/api/servers/${a}/start`,
      { bearer: operatorKey },
      {
        action: 'start',
      },
    );
    expect(denied.statusCode).toBe(403);
    expect((await api('GET', '/api/servers', { bearer: operatorKey })).statusCode).toBe(200);
    const relogged = await login(panel, 'op', 'correct horse battery');
    expect((await keysOf(relogged)).map((k) => k.role)).toEqual(['viewer']);
    // Ligne réécrite à la main au-dessus du rôle du compte : le plafond s'applique aussi à la
    // résolution, pas seulement à l'écriture (défense en profondeur, comme pour les portées).
    panel.ctx.db
      .update(apiKeysTable)
      .set({ role: 'operator' })
      .where(eq(apiKeysTable.userId, opId))
      .run();
    expect((await api('POST', `/api/servers/${a}/start`, { bearer: operatorKey })).statusCode).toBe(
      403,
    );
    expect(
      (await api('GET', '/api/auth/me', { bearer: operatorKey })).json<{ user: { role: string } }>()
        .user.role,
    ).toBe('viewer');

    // Désactivé : la clé ne répond plus. Supprimé : la ligne part avec le compte.
    expect(
      (await api('PATCH', `/api/users/${opId}`, { cookie: admin }, { isActive: false })).statusCode,
    ).toBe(200);
    expect((await api('GET', '/api/servers', { bearer: operatorKey })).statusCode).toBe(401);
    expect((await api('DELETE', `/api/users/${opId}`, { cookie: admin })).statusCode).toBe(204);
    expect(panel.ctx.apiKeys.listAll()).toHaveLength(0);
    expect((await api('GET', '/api/servers', { bearer: operatorKey })).statusCode).toBe(401);
  });

  it('compte limité : la clé hérite des portées, plafonnées par son propre rôle', async () => {
    const res = await api(
      'POST',
      '/api/users',
      { cookie: admin },
      {
        username: 'ami',
        password: 'correct horse battery',
        role: 'operator',
        scoped: true,
      },
    );
    expect(res.statusCode).toBe(201);
    const amiId = res.json<{ user: { id: string } }>().user.id;
    expect(
      (
        await api(
          'PUT',
          `/api/users/${amiId}/grants`,
          { cookie: admin },
          {
            servers: [{ serverId: a, role: 'operator' }],
          },
        )
      ).statusCode,
    ).toBe(200);
    const ami = await login(panel, 'ami', 'correct horse battery');
    const operatorKey = (await createKey(ami, { name: 'op', role: 'operator' })).token;
    const viewerKey = (await createKey(ami, { name: 'ro' })).token;

    // Clé opérateur : A visible et pilotable, B n'existe pas.
    expect((await api('GET', `/api/servers/${a}`, { bearer: operatorKey })).statusCode).toBe(200);
    expect((await api('GET', `/api/servers/${b}`, { bearer: operatorKey })).statusCode).toBe(404);
    const act = await api(
      'POST',
      `/api/servers/${a}/start`,
      { bearer: operatorKey },
      {
        action: 'start',
      },
    );
    expect([401, 403, 404]).not.toContain(act.statusCode);
    const listed = await api('GET', '/api/servers', { bearer: operatorKey });
    expect(listed.json<{ servers: { id: string }[] }>().servers.map((s) => s.id)).toEqual([a]);

    // Clé viewer du même compte : A visible mais plus pilotable — la portée accordée « opérateur »
    // redescend au rôle de la clé (`snapshotFor`), sur la route comme sur l'action groupée.
    expect((await api('GET', `/api/servers/${a}`, { bearer: viewerKey })).statusCode).toBe(200);
    expect(
      (await api('POST', `/api/servers/${a}/start`, { bearer: viewerKey }, { action: 'start' }))
        .statusCode,
    ).toBe(403);
    expect((await api('GET', `/api/servers/${b}`, { bearer: viewerKey })).statusCode).toBe(404);
    expect(
      (
        await api(
          'POST',
          '/api/servers/bulk-action',
          { bearer: viewerKey },
          {
            action: 'start',
            serverIds: [a],
          },
        )
      ).statusCode,
    ).toBe(403);
    // `me.grants` par la clé : les portées telles que la clé les voit.
    const me = await api('GET', '/api/auth/me', { bearer: viewerKey });
    expect(me.json<{ user: { role: string; scoped: boolean } }>().user).toMatchObject({
      role: 'viewer',
      scoped: true,
    });
  });

  it('expiration puis purge ; révocation : la sienne, celle d’un autre (404), admin (tout, audité)', async () => {
    const { key, token } = await createKey(op, { name: 'temp', expiresInDays: 1 });
    expect(key.expiresAt).toBe(panel.clock.now() + DAY);
    expect((await api('GET', '/api/servers', { bearer: token })).statusCode).toBe(200);
    panel.clock.advance(2 * DAY);
    const expired = await api('GET', '/api/servers', { bearer: token });
    expect(expired.statusCode).toBe(401);
    expect(expired.json<Body>().details?.reason).toBe('INVALID_API_KEY');
    // Encore listée (l'écran dit « expirée »), purgée après le délai de grâce seulement.
    expect((await keysOf(op)).map((k) => k.id)).toContain(key.id);
    runMaintenance(panel.ctx);
    expect((await keysOf(op)).map((k) => k.id)).toContain(key.id);
    panel.clock.advance(EXPIRED_KEY_GRACE_MS);
    runMaintenance(panel.ctx);
    // 32 jours plus tard, la session cookie de 30 jours est périmée : on se reconnecte.
    op = await login(panel, 'op', 'correct horse battery');
    admin = await login(panel, 'admin', 'correct horse battery');
    expect((await keysOf(op)).map((k) => k.id)).not.toContain(key.id);

    // Révoquer la sienne : 204 puis 401. Celle d'un autre : introuvable pour un non-admin.
    const mine = await createKey(op, { name: 'mine' });
    const viewer = await createUser(panel, admin, {
      username: 'lecteur',
      password: 'correct horse battery',
      role: 'viewer',
    });
    expect(
      (await api('DELETE', `/api/api-keys/${mine.key.id}`, { cookie: viewer })).statusCode,
    ).toBe(404);
    expect((await api('GET', '/api/servers', { bearer: mine.token })).statusCode).toBe(200);
    expect((await api('DELETE', `/api/api-keys/${mine.key.id}`, { cookie: op })).statusCode).toBe(
      204,
    );
    expect((await api('GET', '/api/servers', { bearer: mine.token })).statusCode).toBe(401);

    // Admin : voit tout (avec le propriétaire), révoque tout, audité. Un opérateur n'a pas `all`.
    const theirs = await createKey(viewer, { name: 'theirs' });
    expect((await api('GET', '/api/api-keys?all=true', { cookie: op })).statusCode).toBe(403);
    const all = await keysOf(admin, true);
    expect(all.map((k) => [k.username, k.name])).toContainEqual(['lecteur', 'theirs']);
    expect(
      (await api('DELETE', `/api/api-keys/${theirs.key.id}`, { cookie: admin })).statusCode,
    ).toBe(204);
    expect((await api('GET', '/api/servers', { bearer: theirs.token })).statusCode).toBe(401);
    const revoked = panel.ctx.audit.list(10).find((e) => e.action === 'apikey.revoked');
    expect(revoked?.username).toBe('admin');
    expect(revoked?.targetId).toBe(theirs.key.id);

    // Par une clé, l'audit nomme le compte ET la clé.
    const opKey = await createKey(admin, { name: 'auditée', role: 'admin' });
    const renamed = await api(
      'PATCH',
      `/api/servers/${a}`,
      { bearer: opKey.token },
      {
        name: 'A par clé',
      },
    );
    expect(renamed.statusCode, renamed.body).toBe(200);
    const viaKey = panel.ctx.audit
      .list(20)
      .find((e) => typeof e.username === 'string' && e.username.includes(opKey.key.prefix));
    expect(viaKey?.username).toBe(`admin [${opKey.key.prefix}…]`);
  });
});
