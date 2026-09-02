/**
 * Lot 4 — garde SSRF des webhooks sortants. Un webhook est une URL choisie par un administrateur
 * vers laquelle le panel fait un POST depuis SA machine : sans filtre, c'est un relais vers tout
 * ce que cette machine voit — le panel lui-même sur 127.0.0.1, les agents, un NAS, les métadonnées
 * d'un cloud (169.254.169.254), le tailnet (100.64/10, fd7a:…). Doc 03 §6 notait l'absence de
 * filtre ; un webhook configurable est le vecteur le plus direct.
 *
 * Trois barrières, dans l'ordre : l'URL (https seul, pas d'identifiants), le nom d'hôte (noms
 * locaux et MagicDNS refusés avant toute résolution), puis CHAQUE adresse résolue. L'adresse
 * retenue est ÉPINGLÉE : le transport se connecte à elle et non au nom — un DNS qui répondrait une
 * adresse publique à la validation puis 127.0.0.1 à l'envoi (rebinding) n'obtient rien.
 */
import { promises as dns } from 'node:dns';
import net from 'node:net';

export interface LookupResult {
  address: string;
  family: number;
}
export type LookupFn = (hostname: string) => Promise<LookupResult[]>;

/** Toutes les adresses, dans l'ordre du résolveur : la première publique est celle qu'on épingle. */
export const defaultLookup: LookupFn = (hostname) =>
  dns.lookup(hostname, { all: true, order: 'verbatim' });

export type WebhookTargetReason =
  | 'BAD_URL'
  | 'BAD_SCHEME'
  | 'CREDENTIALS'
  | 'BLOCKED_HOST'
  | 'BLOCKED_ADDRESS'
  | 'UNRESOLVABLE'
  | 'NOT_DISCORD';

export class WebhookTargetError extends Error {
  constructor(
    readonly reason: WebhookTargetReason,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'WebhookTargetError';
  }
}

export interface WebhookTarget {
  url: URL;
  hostname: string;
  port: number;
  /** Adresse épinglée : celle que le transport contacte (SNI et `Host` restent le nom). */
  address: string;
  family: 4 | 6;
}

/**
 * Suffixes qui ne désignent que le réseau local ou le tailnet (`ts.net` = MagicDNS Tailscale),
 * plus les TLD réservés qui ne résolvent jamais sur Internet. Un nom sans point est refusé aussi :
 * il ne se résout que par les domaines de recherche de la machine.
 */
const BLOCKED_SUFFIXES = [
  'localhost',
  'local',
  'internal',
  'home.arpa',
  'ts.net',
  'lan',
  'home',
  'intranet',
  'corp',
  'private',
  'onion',
  'test',
  'invalid',
];

const DISCORD_HOSTS = new Set([
  'discord.com',
  'discordapp.com',
  'canary.discord.com',
  'ptb.discord.com',
]);
const DISCORD_PATH = /^\/api\/webhooks\/\d{1,32}\/[A-Za-z0-9_-]{1,256}$/;

function v4ToInt(ip: string): number {
  let value = 0;
  for (const part of ip.split('.')) value = value * 256 + Number(part);
  return value >>> 0;
}

const BLOCKED_V4 = (
  [
    ['0.0.0.0/8', 'unspecified'],
    ['10.0.0.0/8', 'private'],
    // CGNAT — et les adresses Tailscale, qui empruntent cette plage.
    ['100.64.0.0/10', 'cgnat'],
    ['127.0.0.0/8', 'loopback'],
    // Dont 169.254.169.254, les métadonnées d'instance de tous les clouds.
    ['169.254.0.0/16', 'link-local'],
    ['172.16.0.0/12', 'private'],
    ['192.0.0.0/24', 'reserved'],
    ['192.0.2.0/24', 'documentation'],
    ['192.168.0.0/16', 'private'],
    ['198.18.0.0/15', 'reserved'],
    ['198.51.100.0/24', 'documentation'],
    ['203.0.113.0/24', 'documentation'],
    ['224.0.0.0/4', 'multicast'],
    ['240.0.0.0/4', 'reserved'],
  ] as const
).map(([cidr, label]) => {
  const [base = '0.0.0.0', bits = '32'] = cidr.split('/');
  const width = Number(bits);
  const mask = width === 0 ? 0 : (0xffffffff << (32 - width)) >>> 0;
  return { base: (v4ToInt(base) & mask) >>> 0, mask, label };
});

function blockedV4(ip: string): string | undefined {
  const value = v4ToInt(ip);
  for (const { base, mask, label } of BLOCKED_V4) {
    if ((value & mask) >>> 0 === base) return label;
  }
  return undefined;
}

/** 16 octets d'une IPv6 déjà validée par `net.isIPv6` (zone `%eth0` ignorée, IPv4 finale acceptée). */
function parseV6(ip: string): Uint8Array | undefined {
  const zone = ip.indexOf('%');
  const text = zone === -1 ? ip : ip.slice(0, zone);
  const gap = text.indexOf('::');
  const head = gap === -1 ? text : text.slice(0, gap);
  const tail = gap === -1 ? '' : text.slice(gap + 2);
  const groupsOf = (part: string): number[] | undefined => {
    if (part === '') return [];
    const out: number[] = [];
    const groups = part.split(':');
    for (const [i, group] of groups.entries()) {
      if (group.includes('.')) {
        if (i !== groups.length - 1 || !net.isIPv4(group)) return undefined;
        const v4 = v4ToInt(group);
        out.push(v4 >>> 16, v4 & 0xffff);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/i.test(group)) return undefined;
      out.push(Number.parseInt(group, 16));
    }
    return out;
  };
  const h = groupsOf(head);
  const t = groupsOf(tail);
  if (h === undefined || t === undefined) return undefined;
  const missing = 8 - h.length - t.length;
  if (missing < 0 || (gap === -1 && missing !== 0)) return undefined;
  const groups = [...h, ...new Array<number>(gap === -1 ? 0 : missing).fill(0), ...t];
  if (groups.length !== 8) return undefined;
  const bytes = new Uint8Array(16);
  groups.forEach((group, i) => {
    bytes[i * 2] = group >> 8;
    bytes[i * 2 + 1] = group & 0xff;
  });
  return bytes;
}

function embeddedV4(bytes: Uint8Array, offset: number): string {
  return `${String(bytes[offset])}.${String(bytes[offset + 1])}.${String(bytes[offset + 2])}.${String(bytes[offset + 3])}`;
}

function blockedV6(ip: string): string | undefined {
  const b = parseV6(ip);
  if (b === undefined) return 'invalid';
  const zero = (from: number, to: number): boolean => b.subarray(from, to).every((x) => x === 0);
  if (zero(0, 16)) return 'unspecified';
  if (zero(0, 15) && b[15] === 1) return 'loopback';
  // ::ffff:a.b.c.d (IPv4 mappée) et ::a.b.c.d (compatible, obsolète) : c'est l'IPv4 qui compte.
  if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return blockedV4(embeddedV4(b, 12));
  if (zero(0, 12)) return blockedV4(embeddedV4(b, 12)) ?? 'reserved';
  // 64:ff9b::/96 (NAT64) et 2002::/16 (6to4) embarquent aussi une IPv4.
  if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zero(4, 12)) {
    return blockedV4(embeddedV4(b, 12));
  }
  if (b[0] === 0x20 && b[1] === 0x02) return blockedV4(embeddedV4(b, 2));
  if (b[0] === 0xfe && ((b[1] ?? 0) & 0xc0) === 0x80) return 'link-local';
  // fc00::/7 — dont fd7a:115c:a1e0::/48, le préfixe IPv6 de Tailscale.
  if (((b[0] ?? 0) & 0xfe) === 0xfc) return 'unique-local';
  if (b[0] === 0xff) return 'multicast';
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return 'documentation';
  return undefined;
}

/** Étiquette de la plage interdite d'une adresse, `undefined` si elle est publique. */
export function blockedAddress(ip: string): string | undefined {
  if (net.isIPv4(ip)) return blockedV4(ip);
  if (net.isIPv6(ip)) return blockedV6(ip);
  return 'invalid';
}

/** Un nom qui ne peut désigner qu'une machine locale (ou du tailnet) est refusé avant résolution. */
export function blockedHostname(hostname: string): string | undefined {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host === '') return 'empty';
  if (!host.includes('.')) return 'single-label';
  for (const suffix of BLOCKED_SUFFIXES) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return suffix;
  }
  return undefined;
}

export interface ResolveOptions {
  lookup?: LookupFn | undefined;
  /** Genre `discord` : l'hôte et le chemin doivent être ceux d'un webhook Discord. */
  discord?: boolean | undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Valide l'URL, refuse les noms locaux, résout et contrôle chaque adresse, puis rend la cible avec
 * l'adresse épinglée. Toute sortie en erreur est une `WebhookTargetError` dont `reason` nomme la
 * barrière franchie (traduite par l'UI : `errors:E_VALIDATION_<reason>`).
 */
export async function resolveWebhookTarget(
  raw: string,
  options: ResolveOptions = {},
): Promise<WebhookTarget> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebhookTargetError('BAD_URL', `not a URL: ${raw.slice(0, 80)}`);
  }
  if (url.protocol !== 'https:') {
    throw new WebhookTargetError('BAD_SCHEME', `scheme ${url.protocol} refused (https only)`, {
      scheme: url.protocol,
    });
  }
  if (url.username !== '' || url.password !== '') {
    throw new WebhookTargetError('CREDENTIALS', 'credentials in a webhook URL are refused');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    options.discord === true &&
    (!DISCORD_HOSTS.has(hostname) || !DISCORD_PATH.test(url.pathname))
  ) {
    throw new WebhookTargetError(
      'NOT_DISCORD',
      'not a Discord webhook URL (https://discord.com/api/webhooks/<id>/<token>)',
      { hostname },
    );
  }
  const literalFamily = net.isIP(hostname);
  if (literalFamily === 0) {
    const blocked = blockedHostname(hostname);
    if (blocked !== undefined) {
      throw new WebhookTargetError('BLOCKED_HOST', `hostname ${hostname} refused (${blocked})`, {
        hostname,
        range: blocked,
      });
    }
  }
  let addresses: LookupResult[];
  if (literalFamily !== 0) {
    addresses = [{ address: hostname, family: literalFamily }];
  } else {
    try {
      addresses = await (options.lookup ?? defaultLookup)(hostname);
    } catch (error) {
      throw new WebhookTargetError('UNRESOLVABLE', `${hostname}: ${messageOf(error)}`, {
        hostname,
      });
    }
  }
  const [first] = addresses;
  if (first === undefined) {
    throw new WebhookTargetError('UNRESOLVABLE', `${hostname}: no address`, { hostname });
  }
  // TOUTES les adresses sont contrôlées : un nom qui mêle une publique et une privée est un
  // piège classique (le résolveur, ou un cache, peut servir l'une ou l'autre).
  for (const entry of addresses) {
    const blocked = blockedAddress(entry.address);
    if (blocked !== undefined) {
      throw new WebhookTargetError(
        'BLOCKED_ADDRESS',
        `${hostname} resolves to ${entry.address} (${blocked})`,
        { hostname, address: entry.address, range: blocked },
      );
    }
  }
  return {
    url,
    hostname,
    port: url.port === '' ? 443 : Number(url.port),
    address: first.address,
    family: first.family === 6 ? 6 : 4,
  };
}
