/**
 * Server List Ping Minecraft Java (handshake état 1 + status request) : test de joignabilité d'un
 * serveur depuis le panel (doc 03 §5 « test de joignabilité intégré »). IPv6 natif via `net.connect`.
 */
import net from 'node:net';

import type { ReachabilityResult } from '@mmo/protocol/client';

function varint(value: number): Buffer {
  const bytes: number[] = [];
  let v = value >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    bytes.push(b);
  } while (v !== 0);
  return Buffer.from(bytes);
}

function readVarint(buffer: Buffer, offset: number): { value: number; size: number } | undefined {
  let value = 0;
  let size = 0;
  for (;;) {
    const b = buffer[offset + size];
    if (b === undefined) return undefined;
    value |= (b & 0x7f) << (7 * size);
    size += 1;
    if ((b & 0x80) === 0) return { value, size };
    if (size > 5) throw new Error('varint too long');
  }
}

function packet(id: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat([varint(id), ...parts]);
  return Buffer.concat([varint(body.length), body]);
}

function mcString(value: string): Buffer {
  const b = Buffer.from(value, 'utf8');
  return Buffer.concat([varint(b.length), b]);
}

/** `[::1]:25565`, `host:25565`, `host` (port par défaut). */
export function parseAddress(address: string, defaultPort = 25565): { host: string; port: number } {
  const bracket = /^\[([^\]]+)\](?::(\d+))?$/.exec(address.trim());
  if (bracket)
    return { host: bracket[1] ?? '', port: bracket[2] ? Number(bracket[2]) : defaultPort };
  const parts = address.trim().split(':');
  if (parts.length === 2) return { host: parts[0] ?? '', port: Number(parts[1]) };
  return { host: address.trim(), port: defaultPort };
}

export function formatAddress(host: string, port: number): string {
  return net.isIPv6(host) ? `[${host}]:${String(port)}` : `${host}:${String(port)}`;
}

function flattenMotd(description: unknown): string | null {
  if (typeof description === 'string') return description;
  if (description && typeof description === 'object') {
    const d = description as { text?: unknown; extra?: unknown[] };
    const parts: string[] = [];
    if (typeof d.text === 'string') parts.push(d.text);
    for (const e of d.extra ?? []) {
      const s = flattenMotd(e);
      if (s) parts.push(s);
    }
    return parts.join('').replace(/§./g, '') || null;
  }
  return null;
}

export async function pingMinecraft(
  address: string,
  options: { timeoutMs?: number; now?: () => number } = {},
): Promise<ReachabilityResult> {
  const { host, port } = parseAddress(address);
  const now = options.now ?? (() => Date.now());
  const started = now();
  const timeoutMs = options.timeoutMs ?? 5_000;
  return new Promise((resolve) => {
    let settled = false;
    let buffer = Buffer.alloc(0);
    const socket = net.connect({ host, port });
    const finish = (result: Omit<ReachabilityResult, 'address' | 'ms'>): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ address: formatAddress(host, port), ms: Math.max(0, now() - started), ...result });
    };
    const timer = setTimeout(() => {
      finish({ ok: false, error: 'timeout', status: null });
    }, timeoutMs);
    socket.once('error', (error) => {
      clearTimeout(timer);
      finish({ ok: false, error: error.message, status: null });
    });
    socket.once('connect', () => {
      socket.write(
        Buffer.concat([
          packet(
            0x00,
            varint(0xffffffff),
            mcString(host),
            Buffer.from([port >> 8, port & 0xff]),
            varint(1),
          ),
          packet(0x00),
        ]),
      );
    });
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      try {
        const len = readVarint(buffer, 0);
        if (len === undefined || buffer.length < len.size + len.value) return;
        const id = readVarint(buffer, len.size);
        if (id === undefined) return;
        const str = readVarint(buffer, len.size + id.size);
        if (str === undefined) return;
        const start = len.size + id.size + str.size;
        const json = JSON.parse(buffer.subarray(start, start + str.value).toString('utf8')) as {
          version?: { name?: string; protocol?: number };
          players?: { online?: number; max?: number };
          description?: unknown;
        };
        clearTimeout(timer);
        finish({
          ok: true,
          error: null,
          status: {
            version: json.version?.name ?? null,
            protocol: json.version?.protocol ?? null,
            online: json.players?.online ?? null,
            max: json.players?.max ?? null,
            motd: flattenMotd(json.description),
          },
        });
      } catch (error) {
        clearTimeout(timer);
        finish({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          status: null,
        });
      }
    });
    socket.once('close', () => {
      clearTimeout(timer);
      // Connexion acceptée mais fermée sans statut : le port répond (pare-feu ouvert), pas le protocole.
      finish({ ok: false, error: 'closed before status', status: null });
    });
  });
}
