/**
 * Lot 4 — garde SSRF des webhooks : ce qu'elle refuse, et pourquoi, sans toucher au réseau
 * (résolveur injecté). Chaque refus nomme sa barrière (`reason`) et la plage en cause.
 */
import { describe, expect, it } from 'vitest';

import {
  WebhookTargetError,
  blockedAddress,
  blockedHostname,
  resolveWebhookTarget,
  type LookupFn,
} from './ssrf.js';

const PUBLIC_V4 = '93.184.216.34';
const PUBLIC_V6 = '2606:2800:220:1:248:1893:25c8:1946';

/** `<reason>:<plage>` du refus, `ACCEPTED` si la cible passe. */
async function verdict(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'ACCEPTED';
  } catch (error) {
    if (!(error instanceof WebhookTargetError)) return 'OTHER';
    const range = error.details.range;
    return `${error.reason}:${typeof range === 'string' ? range : ''}`;
  }
}

describe('garde SSRF des webhooks', () => {
  it('adresses : privées, locales, CGNAT/tailnet, multicast, réservées — v4, v6 et v4 embarquée', () => {
    const blocked: [string, string][] = [
      ['127.0.0.1', 'loopback'],
      ['10.1.2.3', 'private'],
      ['172.31.255.1', 'private'],
      ['192.168.0.10', 'private'],
      ['100.100.1.2', 'cgnat'],
      ['169.254.169.254', 'link-local'],
      ['0.0.0.0', 'unspecified'],
      ['224.0.0.1', 'multicast'],
      ['255.255.255.255', 'reserved'],
      ['::1', 'loopback'],
      ['::', 'unspecified'],
      ['fe80::1', 'link-local'],
      ['fd7a:115c:a1e0::1', 'unique-local'],
      ['fc00::1', 'unique-local'],
      ['ff02::1', 'multicast'],
      ['::ffff:127.0.0.1', 'loopback'],
      ['::ffff:10.0.0.1', 'private'],
      ['64:ff9b::7f00:1', 'loopback'],
      ['2002:c0a8:1::', 'private'],
      ['2001:db8::1', 'documentation'],
    ];
    for (const [ip, range] of blocked) expect(blockedAddress(ip), ip).toBe(range);
    for (const ip of [
      PUBLIC_V4,
      PUBLIC_V6,
      '::ffff:93.184.216.34',
      '8.8.8.8',
      '2001:4860:4860::8888',
    ]) {
      expect(blockedAddress(ip), ip).toBeUndefined();
    }
    expect(blockedAddress('not-an-ip')).toBe('invalid');
  });

  it('noms : local, sans point, MagicDNS Tailscale, TLD réservés — refusés avant toute résolution', () => {
    const blocked = [
      ['localhost', 'single-label'],
      ['nas', 'single-label'],
      ['foo.localhost', 'localhost'],
      ['printer.local', 'local'],
      ['panel.tail29675d.ts.net', 'ts.net'],
      ['db.internal', 'internal'],
      ['router.home.arpa', 'home.arpa'],
      ['x.test', 'test'],
    ] as const;
    for (const [host, why] of blocked) expect(blockedHostname(host), host).toBe(why);
    for (const host of ['discord.com', 'hooks.example.com', 'n8n.mydomain.fr.']) {
      expect(blockedHostname(host), host).toBeUndefined();
    }
  });

  it('URL : https seul, pas d’identifiants, forme Discord exigée pour le genre discord', async () => {
    const lookup: LookupFn = () => Promise.resolve([{ address: PUBLIC_V4, family: 4 }]);
    const at = (url: string, discord = false) =>
      verdict(resolveWebhookTarget(url, { lookup, discord }));
    expect(await at('nope')).toBe('BAD_URL:');
    expect(await at('http://hooks.example.com/x')).toBe('BAD_SCHEME:');
    expect(await at('ftp://hooks.example.com/x')).toBe('BAD_SCHEME:');
    expect(await at('https://user:pw@hooks.example.com/x')).toBe('CREDENTIALS:');
    expect(await at('https://hooks.example.com/api/webhooks/1/abc', true)).toBe('NOT_DISCORD:');
    expect(await at('https://discord.com/api/other/1/abc', true)).toBe('NOT_DISCORD:');
    expect(await at('https://discord.com/api/webhooks/1/abc', false)).toBe('ACCEPTED');
    const ok = await resolveWebhookTarget(
      'https://discord.com/api/webhooks/123456/AbC_d-e?wait=true',
      { lookup, discord: true },
    );
    expect(ok).toMatchObject({ hostname: 'discord.com', port: 443, address: PUBLIC_V4, family: 4 });
    expect(ok.url.search).toBe('?wait=true');
  });

  it('résolution : chaque adresse est contrôlée, la première est épinglée, l’échec DNS est nommé', async () => {
    const mixed: LookupFn = () =>
      Promise.resolve([
        { address: PUBLIC_V4, family: 4 },
        { address: '10.0.0.5', family: 4 },
      ]);
    const at = (url: string, lookup: LookupFn) => verdict(resolveWebhookTarget(url, { lookup }));
    expect(await at('https://hooks.example.com/x', mixed)).toBe('BLOCKED_ADDRESS:private');
    expect(
      await at('https://hooks.example.com/x', () => Promise.reject(new Error('ENOTFOUND'))),
    ).toBe('UNRESOLVABLE:');
    expect(await at('https://hooks.example.com/x', () => Promise.resolve([]))).toBe(
      'UNRESOLVABLE:',
    );
    expect(await at('https://nas.local/x', mixed)).toBe('BLOCKED_HOST:local');
    // Littéraux : contrôlés sans résolution, crochets IPv6 compris.
    expect(await at('https://127.0.0.1:8443/x', mixed)).toBe('BLOCKED_ADDRESS:loopback');
    expect(await at('https://[fd7a:115c:a1e0::1]/x', mixed)).toBe('BLOCKED_ADDRESS:unique-local');
    const v6first: LookupFn = () =>
      Promise.resolve([
        { address: PUBLIC_V6, family: 6 },
        { address: PUBLIC_V4, family: 4 },
      ]);
    const target = await resolveWebhookTarget('https://hooks.example.com:8443/hook', {
      lookup: v6first,
    });
    expect(target).toMatchObject({ address: PUBLIC_V6, family: 6, port: 8443 });
  });
});
