/**
 * Fichiers écrits par l'agent dans un dossier serveur (doc 06 §5, §7 ; doc 04 §3) :
 * auto-provisionnement RCON dans `server.properties`, acceptation de l'EULA, marqueur
 * `.mmo-server.json` (ID attribué par le panel).
 */
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  parseBooleanProperty,
  parseIntProperty,
  parseProperties,
  updateProperties,
  type Properties,
} from './properties.js';

export const MARKER_FILE = '.mmo-server.json';

async function readText(file: string): Promise<string | undefined> {
  try {
    const text = await readFile(file, 'utf8');
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  } catch {
    return undefined;
  }
}

export async function readServerProperties(
  serverDir: string,
): Promise<{ text: string; props: Properties }> {
  const text = (await readText(path.join(serverDir, 'server.properties'))) ?? '';
  return { text, props: parseProperties(text) };
}

export interface RconProvision {
  port: number;
  password: string;
}

/** État RCON lu dans `server.properties`. */
export function rconFromProperties(props: Properties): {
  enabled: boolean;
  port: number | undefined;
  password: string | undefined;
} {
  return {
    enabled: parseBooleanProperty(props.get('enable-rcon')) ?? false,
    port: parseIntProperty(props.get('rcon.port')),
    password: props.get('rcon.password'),
  };
}

export function gamePortFromProperties(props: Properties): number {
  return parseIntProperty(props.get('server-port')) ?? 25565;
}

/**
 * Garantit `enable-rcon=true`, `rcon.port` et `rcon.password` (doc 06 §5). Ne réécrit le fichier
 * que si nécessaire ; `true` si une écriture a eu lieu.
 */
export async function ensureRconProvisioned(
  serverDir: string,
  desired: RconProvision,
): Promise<boolean> {
  const { text, props } = await readServerProperties(serverDir);
  const current = rconFromProperties(props);
  if (current.enabled && current.port === desired.port && current.password === desired.password) {
    return false;
  }
  const next = updateProperties(text, {
    'enable-rcon': 'true',
    'rcon.port': String(desired.port),
    'rcon.password': desired.password,
  });
  await writeFile(path.join(serverDir, 'server.properties'), next, 'utf8');
  return true;
}

/** Mot de passe RCON fort (192 bits, base64url — sans caractères problématiques pour Java Properties). */
export function generateRconPassword(): string {
  return randomBytes(24).toString('base64url');
}

export async function isEulaAccepted(serverDir: string): Promise<boolean> {
  const text = await readText(path.join(serverDir, 'eula.txt'));
  if (text === undefined) return false;
  return parseBooleanProperty(parseProperties(text).get('eula')) ?? false;
}

export async function acceptEula(serverDir: string): Promise<void> {
  const file = path.join(serverDir, 'eula.txt');
  const text = (await readText(file)) ?? '';
  const next = updateProperties(
    text === ''
      ? '#By changing the setting below to TRUE you are indicating your agreement to our EULA (https://aka.ms/MinecraftEULA).\n'
      : text,
    { eula: 'true' },
  );
  await writeFile(file, next, 'utf8');
}

export async function writeMarker(serverDir: string, serverId: string): Promise<void> {
  const file = path.join(serverDir, MARKER_FILE);
  const existing = await readText(file);
  if (existing !== undefined) {
    try {
      const json = JSON.parse(existing) as { serverId?: unknown };
      if (json.serverId === serverId) return;
    } catch {
      // marqueur corrompu : réécrit
    }
  }
  await writeFile(
    file,
    JSON.stringify({ serverId, writtenAt: new Date().toISOString() }, null, 2) + '\n',
    'utf8',
  );
}
