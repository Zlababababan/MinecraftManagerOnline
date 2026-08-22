import { describe, expect, it } from 'vitest';

import { createDnsClient, DnsError } from './dns.js';

const urlOf = (input: string | URL | Request): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

interface Call {
  method: string;
  url: string;
  body: unknown;
}

function fakeCloudflare(records: { id: string; type: string; name: string; content: string }[]) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = (input, init) => Promise.resolve(handle(input, init));
  const handle = (input: string | URL | Request, init: RequestInit | undefined): Response => {
    const url = new URL(urlOf(input));
    const method = init?.method ?? 'GET';
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, url: url.pathname + url.search, body });
    const auth = (init?.headers as Record<string, string>).Authorization;
    if (auth !== 'Bearer cf-token') {
      return new Response(
        JSON.stringify({ success: false, errors: [{ message: 'Invalid token' }] }),
        { status: 403 },
      );
    }
    const ok = (result: unknown): Response =>
      new Response(JSON.stringify({ success: true, result }), { status: 200 });
    if (url.pathname === '/client/v4/zones')
      return ok([{ id: 'zone1', name: url.searchParams.get('name') }]);
    if (url.pathname === '/client/v4/zones/zone1/dns_records' && method === 'GET') {
      return ok(
        records.filter(
          (r) => r.type === url.searchParams.get('type') && r.name === url.searchParams.get('name'),
        ),
      );
    }
    if (url.pathname === '/client/v4/zones/zone1/dns_records' && method === 'POST') {
      const rec = {
        id: `r${String(records.length + 1)}`,
        ...(body as { type: string; name: string; content: string }),
      };
      records.push(rec);
      return ok(rec);
    }
    const m = /^\/client\/v4\/zones\/zone1\/dns_records\/(r\d+)$/.exec(url.pathname);
    if (m && method === 'DELETE') {
      const i = records.findIndex((r) => r.id === m[1]);
      if (i >= 0) records.splice(i, 1);
      return ok({ id: m[1] });
    }
    if (m && method === 'PATCH') {
      const rec = records.find((r) => r.id === m[1]);
      if (rec) rec.content = (body as { content: string }).content;
      return ok(rec);
    }
    return new Response('{}', { status: 404 });
  };
  return { calls, fetchImpl };
}

describe('dns providers', () => {
  it('cloudflare : TXT posé puis retiré, AAAA créé puis mis à jour, zone déduite du domaine', async () => {
    const records: { id: string; type: string; name: string; content: string }[] = [];
    const cf = fakeCloudflare(records);
    const client = createDnsClient(
      { provider: 'cloudflare', domain: 'panel.example.org', token: 'cf-token' },
      cf.fetchImpl,
    );
    expect(client.supportsChallenge && client.supportsDynDns).toBe(true);
    await client.setTxt('_acme-challenge.panel.example.org', 'v1');
    expect(records).toEqual([
      { id: 'r1', type: 'TXT', name: '_acme-challenge.panel.example.org', content: 'v1', ttl: 60 },
    ]);
    await client.removeTxt('_acme-challenge.panel.example.org', 'v1');
    expect(records).toEqual([]);
    await client.updateAddress('panel.example.org', '2001:db8::1', undefined);
    expect(records.map((r) => [r.type, r.content])).toEqual([['AAAA', '2001:db8::1']]);
    await client.updateAddress('panel.example.org', '2001:db8::2', undefined);
    expect(records.map((r) => [r.type, r.content])).toEqual([['AAAA', '2001:db8::2']]);
    await client.updateAddress('panel.example.org', '2001:db8::2', undefined);
    expect(cf.calls.filter((c) => c.method === 'PATCH')).toHaveLength(1);
    expect(cf.calls[0]?.url).toBe('/client/v4/zones?name=example.org');
  });

  it('cloudflare : jeton refusé ⇒ DnsError avec le message de l’API', async () => {
    const cf = fakeCloudflare([]);
    const client = createDnsClient(
      { provider: 'cloudflare', domain: 'panel.example.org', token: 'bad' },
      cf.fetchImpl,
    );
    await expect(client.setTxt('x', 'y')).rejects.toThrow(/Invalid token/);
  });

  it('generic : URL de mise à jour avec substitutions, pas de DNS-01', async () => {
    const seen: string[] = [];
    const fetchImpl: typeof fetch = (input) => {
      seen.push(urlOf(input));
      return Promise.resolve(new Response('good 2001:db8::9', { status: 200 }));
    };
    const client = createDnsClient(
      {
        provider: 'generic',
        domain: 'home.dynv6.net',
        token: 'tok',
        updateUrl: 'https://dynv6.com/api/update?hostname={host}&token={token}&ipv6={ipv6}',
      },
      fetchImpl,
    );
    expect(client.supportsChallenge).toBe(false);
    await client.updateAddress('home.dynv6.net', '2001:db8::9', undefined);
    expect(seen).toEqual([
      'https://dynv6.com/api/update?hostname=home.dynv6.net&token=tok&ipv6=2001%3Adb8%3A%3A9',
    ]);
    await expect(client.setTxt('a', 'b')).rejects.toBeInstanceOf(DnsError);
  });

  it('duckdns : `KO` ⇒ erreur ; sous-domaine extrait du domaine complet', async () => {
    const seen: URL[] = [];
    const fetchImpl: typeof fetch = (input) => {
      seen.push(new URL(urlOf(input)));
      return Promise.resolve(new Response('KO', { status: 200 }));
    };
    const client = createDnsClient(
      { provider: 'duckdns', domain: 'mmo.duckdns.org', token: 't' },
      fetchImpl,
    );
    await expect(client.setTxt('_acme-challenge.mmo.duckdns.org', 'val')).rejects.toThrow(/KO/);
    expect(seen[0]?.searchParams.get('domains')).toBe('mmo');
    expect(seen[0]?.searchParams.get('txt')).toBe('val');
  });

  it('manual : rien n’est automatisé', async () => {
    const client = createDnsClient({ provider: 'manual', domain: 'x' }, fetch);
    await expect(client.setTxt('a', 'b')).resolves.toBeUndefined();
    await expect(client.updateAddress('x', '::1', undefined)).rejects.toBeInstanceOf(DnsError);
  });
});
