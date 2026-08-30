/**
 * Phase 10 — notifications : abonnement via l'API, livraison localisée (fr/en) vers un faux
 * endpoint push (déchiffrée avec la clé du « navigateur »), préférences, purge des abonnements morts
 * (410), centre in-app (liste filtrée, non-lus, curseur « vu »).
 */
import { createECDH, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PushPayload } from '@mmo/protocol/client';

import { b64url, decryptPayload, fromB64url } from './push/webpush.js';
import { createTestPanel, createUser, setupAdmin, type TestPanel } from '../test/helpers.js';

const urlOf = (input: string | URL | Request): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

interface Delivered {
  endpoint: string;
  payload: PushPayload;
}

function browserKeys() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return {
    keys: { p256dh: b64url(ecdh.getPublicKey()), auth: b64url(auth) },
    decrypt: (body: Buffer): PushPayload =>
      JSON.parse(decryptPayload(body, ecdh.getPrivateKey(), auth).toString()) as PushPayload,
  };
}

describe('NotificationsService', () => {
  let panel: TestPanel;
  let admin: string;
  const delivered: Delivered[] = [];
  const statusFor = new Map<string, number>();
  const browsers = new Map<string, ReturnType<typeof browserKeys>>();

  const fakeFetch: typeof fetch = (input, init) => {
    const url = urlOf(input);
    if (url.startsWith('https://push.test/')) {
      const status = statusFor.get(url) ?? 201;
      if (status === 201) {
        const browser = browsers.get(url);
        if (browser)
          delivered.push({
            endpoint: url,
            payload: browser.decrypt(Buffer.from(init?.body as Uint8Array)),
          });
      }
      return Promise.resolve(new Response(null, { status }));
    }
    return Promise.reject(new Error(`unexpected fetch ${url}`));
  };

  async function subscribe(cookie: string, endpoint: string): Promise<void> {
    const browser = browserKeys();
    browsers.set(endpoint, browser);
    const res = await panel.app.inject({
      method: 'POST',
      url: '/api/push/subscribe',
      headers: { cookie },
      payload: { endpoint, keys: browser.keys, userAgent: 'vitest' },
    });
    expect(res.statusCode).toBe(200);
  }

  beforeEach(async () => {
    delivered.length = 0;
    statusFor.clear();
    browsers.clear();
    panel = await createTestPanel({ fetch: fakeFetch });
    // Locale explicite : ces tests portent sur la localisation PAR DESTINATAIRE (l'admin en
    // français, un second compte en anglais), pas sur la langue par défaut du produit — qui est
    // l'anglais depuis que le repli suit la langue canonique du dépôt.
    admin = await setupAdmin(panel, {
      username: 'admin',
      password: 'correct horse battery',
      locale: 'fr',
    });
  });
  afterEach(async () => {
    await panel.close();
  });

  it('expose la clé VAPID et accepte un abonnement', async () => {
    const status = await panel.app.inject({
      method: 'GET',
      url: '/api/push',
      headers: { cookie: admin },
    });
    expect(status.statusCode).toBe(200);
    const body = status.json<{ vapidPublicKey: string | null; subscriptions: unknown[] }>();
    expect(body.vapidPublicKey).toMatch(/^[A-Za-z0-9_-]{80,}$/);
    expect(body.subscriptions).toEqual([]);
    await subscribe(admin, 'https://push.test/a/1');
    const after = await panel.app.inject({
      method: 'GET',
      url: '/api/push',
      headers: { cookie: admin },
    });
    const subs = after.json<{ subscriptions: { endpoint: string; userAgent: string }[] }>()
      .subscriptions;
    expect(subs).toHaveLength(1);
    expect(subs[0]?.endpoint).toContain('push.test');
    expect(subs[0]?.userAgent).toBe('vitest');
  });

  it('livre un crash localisé selon la langue de chaque destinataire, purge les 410', async () => {
    const viewer = await createUser(panel, admin, {
      username: 'bob',
      password: 'password-bob',
      role: 'viewer',
    });
    await panel.app.inject({
      method: 'PATCH',
      url: '/api/auth/me',
      headers: { cookie: viewer },
      payload: { locale: 'en' },
    });
    await subscribe(admin, 'https://push.test/admin/1');
    await subscribe(admin, 'https://push.test/admin/dead');
    await subscribe(viewer, 'https://push.test/bob/1');
    statusFor.set('https://push.test/admin/dead', 410);

    const machine = panel.ctx.machines.create('pc');
    panel.ctx.events.publish({
      type: 'server.stateChanged',
      severity: 'error',
      machineId: machine.id,
      serverId: 'srv-1',
      payload: { state: 'crashed', previous: 'running' },
    });
    await panel.ctx.notifications.flush();

    expect(delivered.map((d) => d.endpoint).sort()).toEqual([
      'https://push.test/admin/1',
      'https://push.test/bob/1',
    ]);
    const fr = delivered.find((d) => d.endpoint.includes('admin'))?.payload;
    const en = delivered.find((d) => d.endpoint.includes('bob'))?.payload;
    expect(fr?.title).toBe('srv-1 a planté');
    expect(fr?.body).toBe('Le serveur a planté sur pc.');
    expect(fr?.url).toBe('/servers/srv-1');
    expect(en?.title).toBe('srv-1 crashed');
    expect(en?.locale).toBe('en');
    // L'endpoint 410 a été purgé.
    expect(
      panel.ctx.notifications.subscriptions(panel.ctx.users.findByUsername('admin')?.id ?? ''),
    ).toHaveLength(1);
  });

  it('respecte les préférences (catégorie désactivée, joueurs désactivés par défaut)', async () => {
    await subscribe(admin, 'https://push.test/admin/1');
    const prefs = await panel.app.inject({
      method: 'GET',
      url: '/api/notifications/prefs',
      headers: { cookie: admin },
    });
    expect(prefs.json<{ prefs: Record<string, boolean> }>().prefs).toMatchObject({
      'server.crashed': true,
      'player.activity': false,
    });
    // Sans canal précisé, le réglage vaut pour les deux : c'est le sens de l'ancien réglage unique.
    const put = await panel.app.inject({
      method: 'PUT',
      url: '/api/notifications/prefs',
      headers: { cookie: admin },
      payload: { values: { 'server.crashed': false, 'player.activity': true } },
    });
    const channels = put.json<{ channels: Record<string, Record<string, boolean>> }>().channels;
    for (const channel of ['inapp', 'push']) {
      expect(channels[channel], channel).toMatchObject({
        'server.crashed': false,
        'player.activity': true,
      });
    }

    panel.ctx.events.publish({
      type: 'server.stateChanged',
      severity: 'error',
      serverId: 's',
      payload: { state: 'crashed' },
    });
    panel.ctx.events.publish({
      type: 'player.joined',
      serverId: 's',
      payload: { name: 'Steve', online: 3 },
    });
    panel.ctx.events.publish({ type: 'task.completed', serverId: 's', payload: {} });
    await panel.ctx.notifications.flush();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.payload.title).toBe('Steve a rejoint s');
  });

  it('centre in-app : liste filtrée, non-lus et curseur « vu »', async () => {
    panel.ctx.events.publish({
      type: 'server.stateChanged',
      severity: 'error',
      serverId: 's',
      payload: { state: 'crashed' },
    });
    panel.ctx.events.publish({
      type: 'player.joined',
      serverId: 's',
      payload: { name: 'Steve', online: 3 },
    });
    const failed = panel.ctx.events.publish({
      type: 'task.failed',
      severity: 'error',
      serverId: 's',
      payload: { kind: 'backup.create', error: { code: 'E_IO' } },
    });
    const list = await panel.app.inject({
      method: 'GET',
      url: '/api/notifications',
      headers: { cookie: admin },
    });
    const body = list.json<{
      notifications: { id: number; type: string }[];
      unread: number;
      seenId: number;
    }>();
    expect(body.notifications.map((n) => n.type)).toEqual(['task.failed', 'server.stateChanged']);
    expect(body.unread).toBe(2);
    const seen = await panel.app.inject({
      method: 'POST',
      url: '/api/notifications/seen',
      headers: { cookie: admin },
      payload: { id: failed.id },
    });
    expect(seen.json<{ seenId: number }>().seenId).toBe(failed.id);
    const after = await panel.app.inject({
      method: 'GET',
      url: '/api/notifications',
      headers: { cookie: admin },
    });
    expect(after.json<{ unread: number }>().unread).toBe(0);
  });

  it('push de test et désabonnement', async () => {
    await subscribe(admin, 'https://push.test/admin/1');
    const test = await panel.app.inject({
      method: 'POST',
      url: '/api/push/test',
      headers: { cookie: admin },
    });
    expect(test.json()).toEqual({ sent: 1, failed: 0 });
    expect(delivered[0]?.payload.title).toBe('Notification de test');
    const un = await panel.app.inject({
      method: 'POST',
      url: '/api/push/unsubscribe',
      headers: { cookie: admin },
      payload: { endpoint: 'https://push.test/admin/1' },
    });
    expect(un.json()).toEqual({ removed: true });
  });

  it('refuse un abonnement sans clés VAPID', async () => {
    const fresh = await createTestPanel({ fetch: fakeFetch });
    try {
      // Setup sans passer par le wizard : utilisateur créé directement, pas de VAPID.
      await fresh.ctx.users.create({ username: 'x', password: 'password-xx', role: 'admin' });
      const login = await fresh.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'x', password: 'password-xx' },
      });
      const cookie = String(login.headers['set-cookie']).split(';')[0] ?? '';
      const res = await fresh.app.inject({
        method: 'POST',
        url: '/api/push/subscribe',
        headers: { cookie },
        payload: { endpoint: 'https://push.test/x', keys: { p256dh: 'a', auth: 'b' } },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json<{ code: string }>().code).toBe('E_PUSH_DISABLED');
    } finally {
      await fresh.close();
    }
  });

  it('décode les clés du navigateur (base64url) telles que fournies par PushManager', () => {
    const k = browserKeys();
    expect(fromB64url(k.keys.p256dh)).toHaveLength(65);
    expect(fromB64url(k.keys.auth)).toHaveLength(16);
  });
  /**
   * Le défaut qui a motivé les canaux : couper une catégorie la retirait AUSSI de la cloche.
   * Suivre les arrivées de joueurs dans le panel imposait donc de se faire réveiller la nuit.
   */
  it('canaux séparés : visible dans la cloche, muet sur le téléphone', async () => {
    await subscribe(admin, 'https://push.test/admin/1');
    const put = (payload: Record<string, unknown>) =>
      panel.app.inject({
        method: 'PUT',
        url: '/api/notifications/prefs',
        headers: { cookie: admin },
        payload,
      });
    await put({ channel: 'inapp', values: { 'player.activity': true } });
    await put({ channel: 'push', values: { 'player.activity': false } });

    panel.ctx.events.publish({
      type: 'player.joined',
      serverId: 's',
      payload: { name: 'Steve', online: 3 },
    });
    await panel.ctx.notifications.flush();
    expect(delivered, 'aucun push').toHaveLength(0);

    const center = await panel.app.inject({
      method: 'GET',
      url: '/api/notifications',
      headers: { cookie: admin },
    });
    const list = center.json<{ notifications: { type: string }[] }>().notifications;
    expect(
      list.map((n) => n.type),
      'présent dans la cloche',
    ).toContain('player.joined');
  });

  it('les nouvelles catégories atteignent bien le téléphone', async () => {
    await subscribe(admin, 'https://push.test/admin/1');
    // `agent.problem` est activée par défaut : c'est le cas vécu du dossier non inscriptible.
    panel.ctx.events.publish({
      type: 'agent.log',
      severity: 'warning',
      payload: { level: 'WARN', message: 'server folder is not writable by the agent' },
    });
    await panel.ctx.notifications.flush();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.payload.body).toContain('not writable');

    // `task.done` est éteinte par défaut : une sauvegarde réussie ne réveille personne...
    delivered.length = 0;
    panel.ctx.events.publish({
      type: 'task.completed',
      serverId: 's',
      payload: { kind: 'backup.create', status: 'done' },
    });
    await panel.ctx.notifications.flush();
    expect(delivered).toHaveLength(0);

    // ...jusqu'à ce qu'on le demande explicitement.
    await panel.app.inject({
      method: 'PUT',
      url: '/api/notifications/prefs',
      headers: { cookie: admin },
      payload: { channel: 'push', values: { 'task.done': true } },
    });
    panel.ctx.events.publish({
      type: 'task.completed',
      serverId: 's',
      payload: { kind: 'backup.create', status: 'done' },
    });
    await panel.ctx.notifications.flush();
    expect(delivered).toHaveLength(1);
  });
});
