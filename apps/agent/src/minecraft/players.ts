/**
 * Identité des joueurs (doc 06 §7) : UUID = identité, nom = cache d'affichage.
 * Résolution nom → UUID : `usercache.json` local d'abord, puis API Mojang si `online-mode=true`,
 * sinon UUID v3 hors ligne (`nameUUIDFromBytes("OfflinePlayer:" + name)`, MD5) — identique à
 * ce que calcule le serveur.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { ResolvedPlayer } from '@mmo/protocol';

export const MOJANG_BULK_URL =
  'https://api.minecraftservices.com/minecraft/profile/lookup/bulk/byname';

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** `00000000000000000000000000000000` → `00000000-0000-0000-0000-000000000000`. */
export function formatUuid(hex: string): string {
  const h = hex.replace(/-/g, '').toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/** UUID v3 du mode hors ligne (Java `UUID.nameUUIDFromBytes`). */
export function offlineUuid(name: string): string {
  const md5 = createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  md5[6] = ((md5[6] ?? 0) & 0x0f) | 0x30;
  md5[8] = ((md5[8] ?? 0) & 0x3f) | 0x80;
  return formatUuid(md5.toString('hex'));
}

export interface UserCacheEntry {
  name: string;
  uuid: string;
  expiresOn?: string;
}

export async function readUserCache(serverDir: string): Promise<UserCacheEntry[]> {
  try {
    const raw: unknown = JSON.parse(await readFile(path.join(serverDir, 'usercache.json'), 'utf8'));
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (e): e is UserCacheEntry =>
        typeof e === 'object' &&
        e !== null &&
        typeof (e as { name?: unknown }).name === 'string' &&
        typeof (e as { uuid?: unknown }).uuid === 'string',
    );
  } catch {
    return [];
  }
}

export async function resolveMojang(
  names: string[],
  fetchImpl: FetchLike,
  timeoutMs = 8000,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < names.length; i += 10) {
    const chunk = names.slice(i, i + 10);
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    try {
      const res = await fetchImpl(MOJANG_BULK_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(chunk),
        signal: controller.signal,
      });
      if (!res.ok) continue;
      const json = await res.json();
      if (!Array.isArray(json)) continue;
      for (const p of json) {
        const id = (p as { id?: unknown }).id;
        const name = (p as { name?: unknown }).name;
        if (typeof id === 'string' && typeof name === 'string') {
          out.set(name.toLowerCase(), formatUuid(id));
        }
      }
    } catch {
      // réseau indisponible : les noms restent non résolus
    } finally {
      clearTimeout(timer);
    }
  }
  return out;
}

export interface ResolveOptions {
  serverDir: string;
  onlineMode: boolean;
  fetchImpl?: FetchLike | undefined;
  /**
   * Vie privée (lot 9) : `false` = aucun appel à l'API Mojang, les pseudos absents du
   * `usercache.json` restent `unknown` (défaut `true`).
   */
  allowMojang?: boolean | undefined;
}

export async function resolvePlayers(
  names: string[],
  options: ResolveOptions,
): Promise<ResolvedPlayer[]> {
  const cache = await readUserCache(options.serverDir);
  const byName = new Map(cache.map((e) => [e.name.toLowerCase(), e]));
  const result = new Map<string, ResolvedPlayer>();
  const pending: string[] = [];
  for (const name of names) {
    const key = name.toLowerCase();
    if (result.has(key)) continue;
    const cached = byName.get(key);
    if (cached) {
      result.set(key, { name: cached.name, uuid: formatUuid(cached.uuid), source: 'usercache' });
    } else if (!options.onlineMode) {
      result.set(key, { name, uuid: offlineUuid(name), source: 'offline' });
    } else pending.push(name);
  }
  if (pending.length > 0 && options.allowMojang !== false) {
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    const resolved = await resolveMojang(pending, fetchImpl);
    for (const name of pending) {
      const uuid = resolved.get(name.toLowerCase());
      result.set(
        name.toLowerCase(),
        uuid === undefined
          ? { name, uuid: null, source: 'unknown' }
          : { name, uuid, source: 'mojang' },
      );
    }
  }
  return names.map(
    (n) => result.get(n.toLowerCase()) ?? { name: n, uuid: null, source: 'unknown' },
  );
}
