/**
 * Phase 10 — notifications : abonnement via l'API, livraison localisée (fr/en) vers un faux
 * endpoint push (déchiffrée avec la clé du « navigateur »), préférences, purge des abonnements morts
 * (410), centre in-app (liste filtrée, non-lus, curseur « vu »).
 */
import { createECDH, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PushPayload } from '@mmo/protocol/client';

import { inQuietHours } from './notifications.js';
import { b64url, decryptPayload, fromB64url } from './push/webpush.js';
import { SETTING_KEYS } from './settings.js';
import { createTestPanel, createUser, setupAdmin, type TestPanel } from '../test/helpers.js';

/** Un serveur réel : la mise en silence référence sa ligne (clé étrangère). */
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

    // Lot 8 — les boutons voyagent avec la notification, localisés comme le reste : c'est le
    // PANEL qui décide de ce qu'ils font, le service worker ne fait qu'exécuter.
    expect(fr?.actions).toEqual([
      {
        action: 'restart',
        title: 'Démarrer',
        url: '/api/servers/srv-1/start',
        method: 'POST',
        okBody: 'Démarrage demandé — ouvrez le panel pour suivre.',
        failBody: 'Le panel a refusé : ouvrez-le pour savoir pourquoi.',
      },
      { action: 'console', title: 'Console', url: '/servers/srv-1?tab=console' },
    ]);
    expect(en?.actions?.[0]?.title).toBe('Start');
  });

  it('les boutons ne sont proposés que là où l’on sait quoi faire', async () => {
    await subscribe(admin, 'https://push.test/admin/1');
    const machine = panel.ctx.machines.create('pc');

    // Une alerte « serveur tombé » : mêmes gestes qu'un crash, même si l'événement diffère.
    delivered.length = 0;
    panel.ctx.events.publish({
      type: 'alert.firing',
      severity: 'warning',
      machineId: machine.id,
      serverId: 'srv-1',
      payload: { rule: 'server.down' },
    });
    await panel.ctx.notifications.flush();
    expect(delivered[0]?.payload.actions?.map((a) => a.action)).toEqual(['restart', 'console']);

    // Un démarrage qui échoue : proposer « Démarrer » serait absurde — il faut d'abord LIRE.
    delivered.length = 0;
    panel.ctx.events.publish({
      type: 'server.startFailed',
      severity: 'error',
      machineId: machine.id,
      serverId: 'srv-1',
      payload: { error: { code: 'E_IO' } },
    });
    await panel.ctx.notifications.flush();
    expect(delivered[0]?.payload.actions?.map((a) => a.action)).toEqual(['console']);

    // Une sauvegarde réussie n'appelle aucun geste : le clic ouvre la page, c'est tout.
    await panel.app.inject({
      method: 'PUT',
      url: '/api/notifications/prefs',
      headers: { cookie: admin },
      payload: { values: { 'task.done': true } },
    });
    delivered.length = 0;
    panel.ctx.events.publish({
      type: 'task.completed',
      machineId: machine.id,
      serverId: 'srv-1',
      payload: { kind: 'backup.create', status: 'done' },
    });
    await panel.ctx.notifications.flush();
    expect(delivered[0]?.payload.actions).toBeUndefined();
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

/**
 * Lot 8 — heures calmes et silence par serveur. Deux façons de ne PAS faire sonner un téléphone,
 * et une seule de passer outre : l'urgence. Dans les deux cas la cloche du panel garde tout.
 */
describe('lot 8 — heures calmes et silence par serveur', () => {
  let panel: TestPanel;
  let admin: string;
  let serverId: string;
  let otherId: string;
  const delivered: string[] = [];

  const fakeFetch: typeof fetch = (input) => {
    const url = urlOf(input);
    if (url.startsWith('https://push.test/')) {
      delivered.push(url);
      return Promise.resolve(new Response(null, { status: 201 }));
    }
    return Promise.reject(new Error(`unexpected fetch ${url}`));
  };

  async function subscribe(): Promise<void> {
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    const res = await panel.app.inject({
      method: 'POST',
      url: '/api/push/subscribe',
      headers: { cookie: admin },
      payload: {
        endpoint: 'https://push.test/admin/1',
        keys: { p256dh: b64url(ecdh.getPublicKey()), auth: b64url(randomBytes(16)) },
      },
    });
    expect(res.statusCode).toBe(200);
  }

  /** Publie un événement et attend la file de livraison ; rend le nombre de push partis. */
  async function publish(event: Parameters<typeof panel.ctx.events.publish>[0]): Promise<number> {
    delivered.length = 0;
    panel.ctx.events.publish(event);
    await panel.ctx.notifications.flush();
    return delivered.length;
  }

  beforeEach(async () => {
    delivered.length = 0;
    panel = await createTestPanel({ fetch: fakeFetch });
    admin = await setupAdmin(panel);
    // Fuseau EXPLICITE : sans lui le test lirait celui de la machine (Paris ici, UTC sur les
    // runners) et les heures calmes tomberaient au mauvais moment une fois sur deux.
    panel.ctx.settings.set(SETTING_KEYS.scheduleTimezone, 'UTC');
    const machine = panel.ctx.machines.create('pc');
    const first = await panel.ctx.servers.adoptDetected(
      machine.id,
      detected('/srv/a', 'Alpha', 25_565),
      undefined,
    );
    serverId = first.server!.id;
    const second = await panel.ctx.servers.adoptDetected(
      machine.id,
      detected('/srv/b', 'Beta', 25_566),
      undefined,
    );
    otherId = second.server!.id;
    await subscribe();
    // Les arrivées de joueurs sont muettes par défaut : c'est la catégorie idéale pour éprouver
    // le silence, donc on l'allume d'abord.
    await panel.app.inject({
      method: 'PUT',
      url: '/api/notifications/prefs',
      headers: { cookie: admin },
      payload: { values: { 'player.activity': true } },
    });
  });

  afterEach(async () => {
    await panel.close();
  });

  it('la plage silencieuse traverse minuit, et se lit dans les deux sens', () => {
    // 22 h → 7 h : le cas normal, et c'est un intervalle qui passe par minuit.
    expect(inQuietHours(23 * 60, 22 * 60, 7 * 60)).toBe(true);
    expect(inQuietHours(3 * 60, 22 * 60, 7 * 60)).toBe(true);
    expect(inQuietHours(7 * 60, 22 * 60, 7 * 60)).toBe(false); // borne haute exclue
    expect(inQuietHours(22 * 60, 22 * 60, 7 * 60)).toBe(true); // borne basse incluse
    expect(inQuietHours(12 * 60, 22 * 60, 7 * 60)).toBe(false);
    // Une plage ordinaire (sieste), et une plage vide qui ne doit rien faire taire.
    expect(inQuietHours(14 * 60, 13 * 60, 15 * 60)).toBe(true);
    expect(inQuietHours(16 * 60, 13 * 60, 15 * 60)).toBe(false);
    expect(inQuietHours(3 * 60, 60, 60)).toBe(false);
  });

  it('pendant les heures calmes le téléphone se tait, sauf urgence — la cloche garde tout', async () => {
    const put = await panel.app.inject({
      method: 'PUT',
      url: '/api/notifications/quiet-hours',
      headers: { cookie: admin },
      payload: { quietHours: { from: 22 * 60, to: 7 * 60 } },
    });
    expect(put.statusCode, put.body).toBe(200);

    // 23 h UTC : dans la plage. Un joueur qui arrive ne réveille personne…
    panel.clock.set(Date.UTC(2026, 6, 1, 23, 0));
    expect(
      await publish({ type: 'player.joined', serverId, payload: { name: 'Alice', online: 1 } }),
    ).toBe(0);
    // …mais la cloche l'a DÉJÀ, pendant la plage : c'est là que se joue la promesse « le panel
    // garde tout ». Vérifiée plus tard, hors de la plage, elle ne prouverait rien.
    const userDuringQuiet = panel.ctx.users.list()[0]!.id;
    expect(
      panel.ctx.notifications
        .list(userDuringQuiet, 50)
        .notifications.filter((e) => e.type === 'player.joined'),
    ).toHaveLength(1);

    // …mais une alerte passe : être silencieux la nuit ne doit pas vouloir dire apprendre au
    // matin que le serveur est tombé à 23 h. `alert.firing` porte pourtant `warning`.
    expect(
      await publish({
        type: 'alert.firing',
        severity: 'warning',
        serverId,
        payload: { rule: 'server.down' },
      }),
    ).toBe(1);
    // Et une erreur franche aussi.
    expect(
      await publish({
        type: 'server.stateChanged',
        severity: 'error',
        serverId,
        payload: { state: 'crashed' },
      }),
    ).toBe(1);

    // 8 h : hors de la plage, tout repart.
    panel.clock.set(Date.UTC(2026, 6, 2, 8, 0));
    expect(
      await publish({ type: 'player.joined', serverId, payload: { name: 'Alice', online: 1 } }),
    ).toBe(1);

    // La cloche, elle, a tout gardé — y compris ce que le téléphone n'a pas sonné.
    const bell = panel.ctx.notifications.list(userDuringQuiet, 50);
    expect(bell.notifications.filter((e) => e.type === 'player.joined')).toHaveLength(2);

    // Retirer le réglage rend la nuit bruyante de nouveau.
    await panel.app.inject({
      method: 'PUT',
      url: '/api/notifications/quiet-hours',
      headers: { cookie: admin },
      payload: { quietHours: null },
    });
    panel.clock.set(Date.UTC(2026, 6, 2, 23, 0));
    expect(
      await publish({ type: 'player.joined', serverId, payload: { name: 'Alice', online: 1 } }),
    ).toBe(1);
  });

  it('un serveur mis en silence ne fait plus sonner ce compte, et lui seul', async () => {
    const mute = await panel.app.inject({
      method: 'PUT',
      url: `/api/servers/${serverId}/notifications`,
      headers: { cookie: admin },
      payload: { muted: true },
    });
    expect(mute.statusCode, mute.body).toBe(200);
    expect(mute.json<{ muted: boolean }>().muted).toBe(true);

    // Rien pour le serveur en silence, même une erreur : c'est un choix explicite et permanent,
    // pas une plage horaire — l'urgence ne le contourne pas.
    expect(
      await publish({
        type: 'server.stateChanged',
        severity: 'error',
        serverId,
        payload: { state: 'crashed' },
      }),
    ).toBe(0);
    // L'autre serveur sonne toujours.
    expect(
      await publish({
        type: 'server.stateChanged',
        severity: 'error',
        serverId: otherId,
        payload: { state: 'crashed' },
      }),
    ).toBe(1);
    // Et la cloche a gardé les DEUX crashs, y compris celui du serveur en silence.
    const userId = panel.ctx.users.list()[0]!.id;
    expect(
      panel.ctx.notifications
        .list(userId, 50)
        .notifications.filter((e) => e.type === 'server.stateChanged'),
    ).toHaveLength(2);

    // Le réglage se relit, et la page Compte sait le nommer.
    const prefs = await panel.app.inject({
      method: 'GET',
      url: '/api/notifications/prefs',
      headers: { cookie: admin },
    });
    const muted = prefs.json<{ mutedServers: { serverId: string; name: string }[] }>().mutedServers;
    expect(muted.map((m) => [m.serverId, m.name])).toEqual([[serverId, 'Alpha']]);

    // Réactiver le fait sonner de nouveau.
    await panel.app.inject({
      method: 'PUT',
      url: `/api/servers/${serverId}/notifications`,
      headers: { cookie: admin },
      payload: { muted: false },
    });
    expect(
      await publish({
        type: 'server.stateChanged',
        severity: 'error',
        serverId,
        payload: { state: 'crashed' },
      }),
    ).toBe(1);
  });

  it('on ne met pas en silence un serveur qui n’existe pas', async () => {
    const res = await panel.app.inject({
      method: 'PUT',
      url: '/api/servers/inconnu/notifications',
      headers: { cookie: admin },
      payload: { muted: true },
    });
    expect(res.statusCode).toBe(404);
  });
});
