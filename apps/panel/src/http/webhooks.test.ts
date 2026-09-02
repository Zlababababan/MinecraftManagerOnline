/**
 * Lot 4 — webhooks sortants de bout en bout : garde SSRF à la saisie, secret montré une fois,
 * livraison Discord localisée et JSON signé vérifiable, filtrage par catégorie, réessais bornés,
 * épisodes d'échec (un événement, pas un par tentative) et retour à la normale, bouton de test,
 * rotation du secret. Résolveur et transport sont faux ; le vrai transport a son propre test.
 */
import type { InjectOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { WebhookDto } from '@mmo/protocol/client';

import { createTestPanel, createUser, setupAdmin, type TestPanel } from '../test/helpers.js';
import { verifyWebhookSignature } from '../services/webhooks.js';
import type { LookupFn } from '../services/webhooks/ssrf.js';
import type { WebhookTransport } from '../services/webhooks/transport.js';
import { PANEL_VERSION } from '../version.js';

interface Sent {
  hostname: string;
  address: string;
  headers: Record<string, string>;
  body: string;
}

const ADDRESSES = new Map<string, { address: string; family: number }[]>([
  ['discord.com', [{ address: '162.159.135.232', family: 4 }]],
  ['hooks.example.com', [{ address: '93.184.216.34', family: 4 }]],
  ['internal.example.com', [{ address: '10.0.0.5', family: 4 }]],
]);
const DISCORD_URL = 'https://discord.com/api/webhooks/123456789/AbCdEf-gh_ij';

describe('webhooks sortants', () => {
  let panel: TestPanel;
  let admin: string;
  const sent: Sent[] = [];
  /** Réponses programmées par nom d'hôte ; épuisées → 204. Une `Error` = panne réseau. */
  const responses = new Map<string, (number | Error)[]>();

  const lookup: LookupFn = (hostname) => {
    const found = ADDRESSES.get(hostname);
    return found === undefined ? Promise.reject(new Error('ENOTFOUND')) : Promise.resolve(found);
  };
  const transport: WebhookTransport = (request) => {
    sent.push({
      hostname: request.target.hostname,
      address: request.target.address,
      headers: request.headers,
      body: request.body.toString(),
    });
    const next = responses.get(request.target.hostname)?.shift() ?? 204;
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve({
      status: next,
      body: next === 429 ? '{"retry_after":0.01}' : next >= 400 ? '{"message":"nope"}' : '',
      retryAfterMs: undefined,
    });
  };

  beforeEach(async () => {
    sent.length = 0;
    responses.clear();
    panel = await createTestPanel({
      webhooks: { lookup, transport, retryDelaysMs: [5, 5, 5], timeoutMs: 1_000 },
    });
    admin = await setupAdmin(panel, {
      username: 'admin',
      password: 'correct horse battery',
      locale: 'fr',
    });
  });
  afterEach(async () => {
    await panel.close();
  });

  const call = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: Record<string, unknown>,
  ) => {
    const options: InjectOptions = { method, url, headers: { cookie: admin } };
    if (payload !== undefined) options.payload = payload;
    return panel.app.inject(options);
  };
  const create = async (body: Record<string, unknown>) => {
    const res = await call('POST', '/api/webhooks', body);
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ webhook: WebhookDto; secret: string | null }>();
  };
  const list = async () =>
    (await call('GET', '/api/webhooks')).json<{ webhooks: WebhookDto[] }>().webhooks;
  const publish = async (event: Parameters<typeof panel.ctx.events.publish>[0]) => {
    panel.ctx.events.publish(event);
    await panel.ctx.webhooks.flush();
  };
  const bodyOf = (entry: Sent | undefined) =>
    JSON.parse(entry?.body ?? '{}') as {
      embeds?: { title: string; description: string; color: number; footer: { text: string } }[];
      category?: string;
      title?: string;
      event?: { type: string };
    };

  it('garde SSRF à la saisie, secret montré une fois, URL masquée, rôle admin, audit sans secret', async () => {
    const refused = async (body: Record<string, unknown>, reason: string) => {
      const res = await call('POST', '/api/webhooks', body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      const json = res.json<{ code: string; details: { key: string; reason: string } }>();
      expect(json.code).toBe('E_VALIDATION');
      expect(json.details).toMatchObject({ key: 'url', reason });
      return json.details;
    };
    await refused({ name: 'n', kind: 'json', url: 'https://nas.local/hook' }, 'BLOCKED_HOST');
    await refused(
      { name: 'n', kind: 'json', url: 'https://panel.tail29675d.ts.net/x' },
      'BLOCKED_HOST',
    );
    const blocked = await refused(
      { name: 'n', kind: 'json', url: 'https://internal.example.com/hook' },
      'BLOCKED_ADDRESS',
    );
    expect(blocked).toMatchObject({ address: '10.0.0.5', range: 'private' });
    await refused({ name: 'n', kind: 'json', url: 'http://hooks.example.com/hook' }, 'BAD_SCHEME');
    await refused(
      { name: 'n', kind: 'json', url: 'https://nowhere.example.com/hook' },
      'UNRESOLVABLE',
    );
    await refused(
      { name: 'n', kind: 'discord', url: 'https://hooks.example.com/api/webhooks/1/a' },
      'NOT_DISCORD',
    );
    expect(
      (await call('POST', '/api/webhooks', { name: 'n', kind: 'slack', url: DISCORD_URL }))
        .statusCode,
    ).toBe(400);

    const discord = await create({ name: 'Salon #ops', kind: 'discord', url: DISCORD_URL });
    expect(discord.secret).toBeNull();
    expect(discord.webhook).toMatchObject({
      kind: 'discord',
      url: 'https://discord.com/api/webhooks/123456789/••••',
      hasSecret: false,
      enabled: true,
      locale: 'fr',
      failCount: 0,
    });
    expect(discord.webhook.types).toContain('server.crashed');
    expect(discord.webhook.types).not.toContain('player.activity');

    const json = await create({
      name: 'n8n',
      kind: 'json',
      url: 'https://hooks.example.com/mmo?token=zzz',
      locale: 'en',
      types: ['server.startFailed', 'webhook.failed'],
    });
    expect(json.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(json.webhook).toMatchObject({
      kind: 'json',
      url: 'https://hooks.example.com/mmo',
      hasSecret: true,
      locale: 'en',
      types: ['server.startFailed', 'webhook.failed'],
    });
    const listed = await list();
    expect(listed).toHaveLength(2);
    expect(JSON.stringify(listed)).not.toContain(json.secret);
    expect(JSON.stringify(listed)).not.toContain('AbCdEf-gh_ij');
    expect(JSON.stringify(listed)).not.toContain('token=zzz');

    const operator = await createUser(panel, admin, {
      username: 'op',
      password: 'correct horse battery',
      role: 'operator',
    });
    expect(
      (
        await panel.app.inject({
          method: 'GET',
          url: '/api/webhooks',
          headers: { cookie: operator },
        })
      ).statusCode,
    ).toBe(403);

    const patched = await call('PATCH', `/api/webhooks/${json.webhook.id}`, {
      url: 'https://nas.local/x',
    });
    expect(patched.statusCode).toBe(400);
    const renamed = await call('PATCH', `/api/webhooks/${json.webhook.id}`, {
      name: 'n8n prod',
      enabled: false,
    });
    expect(renamed.json<{ webhook: WebhookDto }>().webhook).toMatchObject({
      name: 'n8n prod',
      enabled: false,
    });

    const audit = JSON.stringify(panel.ctx.audit.list());
    expect(audit).toContain('webhook.created');
    expect(audit).toContain('webhook.updated');
    expect(audit).not.toContain(json.secret);
    expect(audit).not.toContain('AbCdEf-gh_ij');

    expect((await call('DELETE', `/api/webhooks/${discord.webhook.id}`)).statusCode).toBe(200);
    expect((await call('DELETE', `/api/webhooks/${discord.webhook.id}`)).statusCode).toBe(404);
    expect(await list()).toHaveLength(1);
  });

  it('livre un embed Discord localisé et un JSON signé vérifiable, filtre par catégorie, jamais soi-même', async () => {
    await create({ name: 'Salon #ops', kind: 'discord', url: DISCORD_URL });
    const json = await create({
      name: 'n8n',
      kind: 'json',
      url: 'https://hooks.example.com/mmo',
      locale: 'en',
      types: ['server.startFailed', 'webhook.failed'],
    });
    await publish({
      type: 'server.startFailed',
      severity: 'error',
      serverId: 'srv1',
      machineId: 'm1',
      payload: { reason: 'EACCES' },
    });
    expect(sent.map((s) => s.hostname).sort()).toEqual(['discord.com', 'hooks.example.com']);
    const discord = sent.find((s) => s.hostname === 'discord.com');
    expect(discord?.address).toBe('162.159.135.232');
    expect(discord?.headers['user-agent']).toBe(`mmo-panel/${PANEL_VERSION}`);
    expect(discord?.headers['x-mmo-event']).toBe('server.startFailed');
    expect(discord?.headers['x-mmo-signature']).toBeUndefined();
    const embed = bodyOf(discord).embeds?.[0];
    expect(embed).toMatchObject({ title: 'Échec du démarrage de srv1', color: 0xeb5757 });
    expect(embed?.description).toContain('EACCES');

    const signed = sent.find((s) => s.hostname === 'hooks.example.com');
    expect(signed?.headers['x-mmo-category']).toBe('server.startFailed');
    expect(
      verifyWebhookSignature(
        json.secret ?? '',
        signed?.headers['x-mmo-signature'],
        signed?.body ?? '',
        {
          now: panel.clock.now(),
        },
      ),
    ).toBe(true);
    expect(
      verifyWebhookSignature(
        json.secret ?? '',
        signed?.headers['x-mmo-signature'],
        `${signed?.body ?? ''} `,
        {
          now: panel.clock.now(),
        },
      ),
    ).toBe(false);
    const payload = bodyOf(signed);
    expect(payload).toMatchObject({
      category: 'server.startFailed',
      event: { type: 'server.startFailed' },
    });
    expect(payload.title).toContain('srv1');

    // Catégorie non retenue par personne : rien ne part.
    sent.length = 0;
    await publish({
      type: 'player.joined',
      severity: 'info',
      serverId: 'srv1',
      payload: { name: 'Steve' },
    });
    expect(sent).toHaveLength(0);
    // Retenue par Discord (défaut) mais pas par le JSON (liste explicite).
    await publish({
      type: 'panel.updateAvailable',
      severity: 'info',
      payload: { version: '9.9.9' },
    });
    expect(sent.map((s) => s.hostname)).toEqual(['discord.com']);
  });

  it('réessaie les réponses transitoires seulement, un événement par épisode, retour à la normale annoncé', async () => {
    const json = await create({
      name: 'n8n',
      kind: 'json',
      url: 'https://hooks.example.com/mmo',
      types: ['server.startFailed', 'webhook.failed'],
    });
    const failing = await create({
      name: 'watcher',
      kind: 'discord',
      url: DISCORD_URL,
      types: ['webhook.failed'],
    });
    const failures = () => panel.ctx.events.list({ type: 'webhook.failed' });
    const startFailed = () =>
      publish({ type: 'server.startFailed', severity: 'error', serverId: 'srv1', payload: {} });
    const own = () => panel.ctx.webhooks.get(json.webhook.id);

    // 500, 500 puis 204 : trois requêtes, livrée, rien à signaler.
    responses.set('hooks.example.com', [500, 500]);
    await startFailed();
    expect(sent.filter((s) => s.hostname === 'hooks.example.com')).toHaveLength(3);
    expect(own()).toMatchObject({ failCount: 0, lastStatus: 204, lastError: null });
    expect(failures()).toHaveLength(0);

    // 404 : définitif — une seule requête, épisode ouvert, UN événement (relayé au second webhook).
    sent.length = 0;
    responses.set('hooks.example.com', [404]);
    await startFailed();
    expect(sent.filter((s) => s.hostname === 'hooks.example.com')).toHaveLength(1);
    expect(own()).toMatchObject({ failCount: 1, lastStatus: 404 });
    expect(own().lastError).toMatch(/^HTTP 404/);
    expect(failures()).toHaveLength(1);
    expect(failures()[0]?.payload).toMatchObject({ webhookId: json.webhook.id, webhook: 'n8n' });
    const relayed = sent.filter((s) => s.headers['x-mmo-event'] === 'webhook.failed');
    expect(relayed.map((s) => s.hostname)).toEqual(['discord.com']);

    // Toujours en panne : le compteur monte, pas de second événement.
    sent.length = 0;
    responses.set('hooks.example.com', [404]);
    await startFailed();
    expect(own().failCount).toBe(2);
    expect(failures()).toHaveLength(1);

    // Panne réseau : l'essai initial et les trois réessais, puis comptée.
    sent.length = 0;
    responses.set(
      'hooks.example.com',
      Array.from({ length: 4 }, () =>
        Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' }),
      ),
    );
    await startFailed();
    expect(sent.filter((s) => s.hostname === 'hooks.example.com')).toHaveLength(4);
    expect(own()).toMatchObject({ failCount: 3, lastStatus: null });
    expect(own().lastError).toContain('ECONNREFUSED');

    // 429 avec retry_after, puis 204 : réessayé, livré, retour à la normale annoncé une fois.
    sent.length = 0;
    responses.set('hooks.example.com', [429]);
    await startFailed();
    expect(sent.filter((s) => s.hostname === 'hooks.example.com')).toHaveLength(2);
    expect(own()).toMatchObject({ failCount: 0, lastStatus: 204, lastError: null });
    const recovered = panel.ctx.events.list({ type: 'webhook.recovered' });
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.payload).toMatchObject({ webhookId: json.webhook.id, failures: 3 });
    expect(failures()).toHaveLength(1);
    expect(failing.webhook.failCount).toBe(0);
  });

  it('bouton de test (sans réessai, sans épisode), rotation du secret, webhook désactivé', async () => {
    const json = await create({
      name: 'n8n',
      kind: 'json',
      url: 'https://hooks.example.com/mmo',
      types: ['server.startFailed'],
    });
    const discord = await create({ name: 'ops', kind: 'discord', url: DISCORD_URL });

    const ok = await call('POST', `/api/webhooks/${json.webhook.id}/test`);
    expect(ok.statusCode).toBe(200);
    expect(ok.json<{ result: unknown }>().result).toMatchObject({
      ok: true,
      status: 204,
      error: null,
    });
    const probe = sent[sent.length - 1];
    expect(probe?.headers['x-mmo-event']).toBe('webhook.test');
    expect(bodyOf(probe).title).toContain('n8n');

    sent.length = 0;
    responses.set('hooks.example.com', [500]);
    const ko = await call('POST', `/api/webhooks/${json.webhook.id}/test`);
    expect(ko.json<{ result: unknown }>().result).toMatchObject({ ok: false, status: 500 });
    expect(sent).toHaveLength(1);
    expect(panel.ctx.webhooks.get(json.webhook.id)).toMatchObject({
      failCount: 0,
      lastStatus: 500,
    });
    expect(panel.ctx.events.list({ type: 'webhook.failed' })).toHaveLength(0);
    expect(JSON.stringify(panel.ctx.audit.list())).toContain('webhook.tested');

    const rotated = await call('POST', `/api/webhooks/${json.webhook.id}/secret`);
    const secret = rotated.json<{ secret: string }>().secret;
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(secret).not.toBe(json.secret);
    sent.length = 0;
    await publish({ type: 'server.startFailed', severity: 'error', serverId: 'srv1', payload: {} });
    const delivered = sent.find((s) => s.hostname === 'hooks.example.com');
    const header = delivered?.headers['x-mmo-signature'];
    const now = panel.clock.now();
    expect(verifyWebhookSignature(secret, header, delivered?.body ?? '', { now })).toBe(true);
    expect(verifyWebhookSignature(json.secret ?? '', header, delivered?.body ?? '', { now })).toBe(
      false,
    );
    const noSecret = await call('POST', `/api/webhooks/${discord.webhook.id}/secret`);
    expect(noSecret.statusCode).toBe(400);
    expect(noSecret.json<{ details: { reason: string } }>().details.reason).toBe('NO_SECRET');

    expect(
      (await call('PATCH', `/api/webhooks/${json.webhook.id}`, { enabled: false })).statusCode,
    ).toBe(200);
    sent.length = 0;
    await publish({ type: 'server.startFailed', severity: 'error', serverId: 'srv1', payload: {} });
    expect(sent.map((s) => s.hostname)).toEqual(['discord.com']);
  });
});
