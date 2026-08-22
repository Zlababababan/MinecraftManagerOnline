/**
 * Phase 10 — couche d'accès : statut et commande `tailscale serve`, test de joignabilité à travers un
 * reverse-proxy (HTTP + WS + frame binaire, `via` tailscale déduit des en-têtes), certificat par ACME
 * DNS-01 en mode **manuel** (TXT affiché puis posé « à la main » dans le faux DNS) avec listener HTTPS
 * démarré à chaud puis rechargé, DynDNS DuckDNS simulé, règles pare-feu, adresse à donner aux amis
 * et test Server List Ping contre un faux serveur Minecraft.
 */
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import type { AccessStatusDto, AccessTestResult, ServerAddressDto } from '@mmo/protocol/client';

import { servers } from '../db/schema.js';
import { startFakeAcme, type FakeAcme } from '../test/acme-fake.js';
import {
  createTestPanel,
  freePort,
  setupAdmin,
  tmpDir,
  waitFor,
  type TestPanel,
} from '../test/helpers.js';

const urlOf = (input: string | URL | Request): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

/** Reverse-proxy HTTP minimal (requêtes + upgrade) qui ajoute les en-têtes de `tailscale serve`. */
function startProxy(targetPort: number): Promise<{ port: number; close(): void }> {
  const server = http.createServer((req, res) => {
    const up = http.request(
      {
        host: '127.0.0.1',
        port: targetPort,
        method: req.method,
        path: req.url,
        headers: {
          ...req.headers,
          'tailscale-user-login': 'friend@example.org',
          'x-forwarded-proto': 'https',
        },
      },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.pipe(res);
      },
    );
    req.pipe(up);
  });
  server.on('upgrade', (req, socket, head) => {
    const upstream = net.connect(targetPort, '127.0.0.1', () => {
      const lines = [`${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/1.1`];
      for (const [k, v] of Object.entries({
        ...req.headers,
        'tailscale-user-login': 'friend@example.org',
      })) {
        lines.push(`${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`);
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length > 0) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: (server.address() as { port: number }).port, close: () => server.close() });
    });
  });
}

/** Faux serveur Minecraft : répond au Server List Ping. */
function startFakeMinecraft(): Promise<{ port: number; close(): void }> {
  const server = net.createServer((socket) => {
    socket.once('data', () => {
      const json = Buffer.from(
        JSON.stringify({
          version: { name: '1.21.1', protocol: 767 },
          players: { online: 2, max: 20 },
          description: { text: 'Hello ', extra: [{ text: '§aworld' }] },
        }),
      );
      const varint = (n: number): Buffer =>
        n < 128 ? Buffer.from([n]) : Buffer.from([(n & 0x7f) | 0x80, n >> 7]);
      const body = Buffer.concat([Buffer.from([0x00]), varint(json.length), json]);
      socket.write(Buffer.concat([varint(body.length), body]));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: (server.address() as { port: number }).port, close: () => server.close() });
    });
  });
}

describe('AccessService', () => {
  let panel: TestPanel;
  let admin: string;
  let acme: FakeAcme;
  let data: Awaited<ReturnType<typeof tmpDir>>;
  let httpsPort: number;
  const duck: URL[] = [];

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(urlOf(input));
    if (url.hostname === 'www.duckdns.org') {
      duck.push(url);
      return new Response(url.searchParams.get('token') === 'secret' ? 'OK' : 'KO', {
        status: 200,
      });
    }
    return fetch(input, init);
  };

  beforeEach(async () => {
    duck.length = 0;
    data = await tmpDir('mmo-access-');
    acme = await startFakeAcme();
    httpsPort = await freePort();
    panel = await createTestPanel({
      fetch: fetchImpl,
      config: { dataDir: data.dir },
      access: {
        localAddresses: () => ({ ipv6: ['2001:db8::1', '2001:db8::2'], ipv4: [] }),
        resolveTxt: (name) => acme.resolveTxt(name),
        acmeDirectory: acme.directoryUrl,
        acme: { pollIntervalMs: 10, propagationTimeoutMs: 5_000, statusTimeoutMs: 5_000 },
        dyndnsIntervalMs: 3_600_000,
        renewIntervalMs: 3_600_000,
      },
    });
    admin = await setupAdmin(panel);
    await panel.listen();
  });
  afterEach(async () => {
    await panel.close();
    await acme.close();
    await data.cleanup();
  });

  async function status(): Promise<AccessStatusDto> {
    const res = await panel.app.inject({
      method: 'GET',
      url: '/api/access',
      headers: { cookie: admin },
    });
    expect(res.statusCode).toBe(200);
    return res.json<{ access: AccessStatusDto }>().access;
  }
  async function patchSettings(body: Record<string, string>): Promise<void> {
    const res = await panel.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: { cookie: admin },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
  }

  it('mode tailscale par défaut : commande `tailscale serve`, `via` déduit des en-têtes', async () => {
    const s = await status();
    expect(s.mode).toBe('tailscale');
    expect(s.tailscaleServeCommand).toBe(`tailscale serve --bg --https=443 http://127.0.0.1:3000`);
    expect(s.direct).toBeNull();
    expect(s.requestVia).toBe('direct');
    const viaTs = await panel.app.inject({
      method: 'GET',
      url: '/api/access',
      headers: { cookie: admin, 'tailscale-user-login': 'me@x' },
    });
    expect(viaTs.json<{ access: AccessStatusDto }>().access.requestVia).toBe('tailscale');
  });

  it('test de joignabilité à travers un reverse-proxy : HTTP, WS et frame binaire intacts', async () => {
    const proxy = await startProxy(Number(new URL(panel.baseUrl).port));
    try {
      const res = await panel.app.inject({
        method: 'POST',
        url: '/api/access/test',
        headers: { cookie: admin },
        payload: { url: `http://127.0.0.1:${String(proxy.port)}/` },
      });
      expect(res.statusCode).toBe(200);
      const result = res.json<{ result: AccessTestResult }>().result;
      expect(result.http.ok).toBe(true);
      expect(result.ws.ok).toBe(true);
      expect(result.binary).toEqual({ ok: true, bytes: 65_536, error: null });
      expect(result.via).toBe('tailscale');
      expect(result.ok).toBe(true);
      expect((await status()).lastTest?.ok).toBe(true);
    } finally {
      proxy.close();
    }
    // URL injoignable : échec rapporté, pas d'exception.
    const dead = await panel.app.inject({
      method: 'POST',
      url: '/api/access/test',
      headers: { cookie: admin },
      payload: { url: 'http://127.0.0.1:9/' },
    });
    expect(dead.json<{ result: AccessTestResult }>().result.ok).toBe(false);
  });

  it('mode direct : certificat par DNS-01 manuel, HTTPS à chaud (WS binaire compris), rechargement', async () => {
    await patchSettings({
      'access.mode': 'direct',
      'access.domain': 'panel.example.org',
      'access.dns.provider': 'manual',
      'access.publicHost': '127.0.0.1',
      'access.httpsPort': String(httpsPort),
      'access.acme.email': 'admin@example.org',
    });
    const before = await status();
    expect(before.direct?.certificate).toBeNull();
    expect(before.https.listening).toBe(false);

    const issue = panel.app.inject({
      method: 'POST',
      url: '/api/access/certificate',
      headers: { cookie: admin },
    });
    // Le TXT à poser apparaît dans le statut : on le « pose » dans le faux DNS.
    await waitFor(() => panel.ctx.access.pendingChallenge !== null);
    const pending = (await status()).direct?.pendingChallenge;
    expect(pending?.name).toBe('_acme-challenge.panel.example.org');
    acme.txt.set(pending?.name ?? '', [pending?.value ?? '']);
    const res = await issue;
    expect(res.statusCode, res.body).toBe(200);
    const cert = res.json<{ certificate: { names: string[]; daysLeft: number } }>().certificate;
    expect(cert.names).toEqual(['panel.example.org']);
    expect(cert.daysLeft).toBeGreaterThan(80);

    const after = await status();
    expect(after.https).toEqual({ listening: true, port: httpsPort });
    expect(after.direct?.pendingChallenge).toBeNull();
    expect(after.direct?.certificateError).toBeNull();

    // HTTPS réel : /api/health puis /ws/probe avec frame binaire, CA de test.
    const tlsOpts = { ca: acme.ca.certPem, servername: 'panel.example.org' };
    const health = await new Promise<number>((resolve, reject) => {
      https
        .get({ host: '127.0.0.1', port: httpsPort, path: '/api/health', ...tlsOpts }, (r) => {
          r.resume();
          resolve(r.statusCode ?? 0);
        })
        .on('error', reject);
    });
    expect(health).toBe(200);
    const echoed = await new Promise<boolean>((resolve, reject) => {
      const ws = new WebSocket(`wss://127.0.0.1:${String(httpsPort)}/ws/probe`, tlsOpts);
      const payload = Buffer.alloc(100_000, 7);
      ws.on('error', reject);
      ws.on('message', (d: Buffer, isBinary: boolean) => {
        if (!isBinary) {
          ws.send(payload, { binary: true });
          return;
        }
        ws.close();
        resolve(Buffer.from(d).equals(payload));
      });
    });
    expect(echoed).toBe(true);

    // Renouvellement : même listener, nouveau contexte TLS.
    const again = panel.app.inject({
      method: 'POST',
      url: '/api/access/certificate',
      headers: { cookie: admin },
    });
    await waitFor(() => panel.ctx.access.pendingChallenge !== null);
    const p2 = panel.ctx.access.pendingChallenge;
    acme.txt.set(p2?.name ?? '', [p2?.value ?? '']);
    expect((await again).statusCode).toBe(200);
    expect(acme.orders).toHaveLength(2);
    expect((await status()).https.listening).toBe(true);
    const audit = await panel.app.inject({
      method: 'GET',
      url: '/api/audit',
      headers: { cookie: admin },
    });
    expect(audit.json<{ audit: { action: string }[] }>().audit.map((a) => a.action)).toContain(
      'access.certificateIssued',
    );
  });

  it('mode direct : DynDNS DuckDNS (IPv6 stable), erreur de jeton rapportée', async () => {
    await patchSettings({
      'access.mode': 'direct',
      'access.domain': 'mmo.duckdns.org',
      'access.dns.provider': 'duckdns',
      'access.dns.token': 'secret',
      'access.dyndns.enabled': 'true',
    });
    // Le secret ne ressort jamais, mais l'UI sait qu'il est renseigné.
    const settings = await panel.app.inject({
      method: 'GET',
      url: '/api/settings',
      headers: { cookie: admin },
    });
    const s = settings.json<{ settings: Record<string, string> }>().settings;
    expect(s['access.dns.token']).toBeUndefined();
    expect(s['access.dns.token.set']).toBe('true');

    const res = await panel.app.inject({
      method: 'POST',
      url: '/api/access/dyndns',
      headers: { cookie: admin },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ address: '2001:db8::1' });
    expect(duck).toHaveLength(1);
    expect(duck[0]?.searchParams.get('domains')).toBe('mmo');
    expect(duck[0]?.searchParams.get('ipv6')).toBe('2001:db8::1');
    const st = await status();
    expect(st.direct?.dyndns).toMatchObject({
      enabled: true,
      publishedAddress: '2001:db8::1',
      currentAddress: '2001:db8::1',
      lastError: null,
    });

    await patchSettings({ 'access.dns.token': 'wrong' });
    const bad = await panel.app.inject({
      method: 'POST',
      url: '/api/access/dyndns',
      headers: { cookie: admin },
    });
    expect(bad.statusCode).toBe(502);
    expect(bad.json<{ code: string }>().code).toBe('E_DNS_FAILED');
    expect((await status()).direct?.dyndns.lastError).toContain('KO');
  });

  it('adresse à donner aux amis, règles pare-feu et Server List Ping', async () => {
    const mc = await startFakeMinecraft();
    try {
      const machine = panel.ctx.machines.create('pc');
      panel.ctx.machines.markOnline(machine.id, {
        machine: {
          hostname: 'pc',
          os: 'windows',
          arch: 'x64',
          addresses: { tailnet: ['100.101.102.103', 'fd7a:115c:a1e0::1'], global: ['2001:db8::1'] },
        },
        agentVersion: '0.10.0',
        protocolVersion: 1,
      });
      const base = {
        machineId: machine.id,
        path: 'E:/srv',
        loader: 'vanilla' as const,
        createdAt: panel.clock.now(),
        updatedAt: panel.clock.now(),
        provisioning: 'ready' as const,
        gamePort: mc.port,
      };
      panel.ctx.db
        .insert(servers)
        .values({ ...base, id: 'srv-a', name: 'Survie', exposeMode: 'tailnet' })
        .run();
      panel.ctx.db
        .insert(servers)
        .values({ ...base, id: 'srv-b', name: 'Creatif', path: 'E:/srv-b', exposeMode: 'direct' })
        .run();

      const addr = async (id: string): Promise<ServerAddressDto> =>
        (
          await panel.app.inject({
            method: 'GET',
            url: `/api/servers/${id}/address`,
            headers: { cookie: admin },
          })
        ).json<{ address: ServerAddressDto }>().address;
      const a = await addr('srv-a');
      expect(a).toMatchObject({
        exposeMode: 'tailnet',
        host: '100.101.102.103',
        port: mc.port,
        source: 'detected',
      });
      expect(a.alternatives).toEqual([`[fd7a:115c:a1e0::1]:${String(mc.port)}`]);
      // Même machine que le panel (adresse globale commune) + domaine configuré ⇒ le domaine prime.
      await patchSettings({ 'access.mode': 'direct', 'access.domain': 'panel.example.org' });
      const b = await addr('srv-b');
      expect(b).toMatchObject({
        exposeMode: 'direct',
        host: 'panel.example.org',
        source: 'domain',
        address: `panel.example.org:${String(mc.port)}`,
      });
      // Surcharge manuelle par machine.
      await panel.app.inject({
        method: 'PATCH',
        url: `/api/machines/${machine.id}`,
        headers: { cookie: admin },
        payload: { tailnetHost: 'pc.tail1234.ts.net' },
      });
      expect((await addr('srv-a')).address).toBe(`pc.tail1234.ts.net:${String(mc.port)}`);
      const machines = await panel.app.inject({
        method: 'GET',
        url: `/api/machines/${machine.id}`,
        headers: { cookie: admin },
      });
      expect(
        machines.json<{ machine: { tailnetHost: string; addresses: { tailnet: string[] } } }>()
          .machine,
      ).toMatchObject({
        tailnetHost: 'pc.tail1234.ts.net',
        addresses: { tailnet: ['100.101.102.103', 'fd7a:115c:a1e0::1'] },
      });

      const fw = await panel.app.inject({
        method: 'GET',
        url: '/api/access/firewall',
        headers: { cookie: admin },
      });
      const rules = fw.json<{
        rules: {
          panel: { port: number; commands: string[] } | null;
          servers: { serverId: string; os: string; commands: string[] }[];
          boxNote: boolean;
        };
      }>().rules;
      expect(rules.panel?.port).toBe(443);
      expect(rules.servers.map((r) => r.serverId)).toEqual(['srv-b']);
      expect(rules.servers[0]?.commands[0]).toContain(`-LocalPort ${String(mc.port)}`);
      expect(rules.boxNote).toBe(true);

      const ping = await panel.app.inject({
        method: 'POST',
        url: '/api/servers/srv-b/reachability',
        headers: { cookie: admin },
        payload: { address: `127.0.0.1:${String(mc.port)}` },
      });
      expect(ping.statusCode, ping.body).toBe(200);
      expect(ping.json<{ result: unknown }>().result).toMatchObject({
        ok: true,
        address: `127.0.0.1:${String(mc.port)}`,
        status: { version: '1.21.1', protocol: 767, online: 2, max: 20, motd: 'Hello world' },
      });
      const closed = await panel.app.inject({
        method: 'POST',
        url: '/api/servers/srv-b/reachability',
        headers: { cookie: admin },
        payload: { address: '127.0.0.1:9' },
      });
      expect(closed.json<{ result: { ok: boolean } }>().result.ok).toBe(false);
    } finally {
      mc.close();
    }
  });
});
