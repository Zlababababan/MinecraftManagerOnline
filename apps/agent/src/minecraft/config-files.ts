/**
 * Sur-couche typée `config.get` / `config.set` / `player.action` (doc 05 §6, doc 06 §7).
 *
 * Règle d'or du routage : serveur **en marche** → commandes (`whitelist add`, `op`, `ban`…), car le
 * serveur réécrit ces fichiers et écraserait toute édition ; serveur **arrêté** → édition directe
 * des fichiers. `server.properties` n'est lu qu'au démarrage : toujours édité sur disque, avec
 * `restartRequired` si le serveur tourne (les clés inconnues et l'ordre sont préservés).
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  CONFIG_DATA_SCHEMAS,
  CONFIG_SET_SCHEMAS,
  ProtocolError,
  type BannedIpEntry,
  type BannedPlayerEntry,
  type ConfigFile,
  type ConfigWarning,
  type OpEntry,
  type ParsedResponsePayload,
  type PlayerActionKind,
  type WhitelistEntry,
} from '@mmo/protocol';

import { sha256, writeAtomic } from '../files/fs-service.js';
import { resolvePlayers, type FetchLike } from './players.js';
import {
  parseBooleanProperty,
  parseIntProperty,
  parseProperties,
  updateProperties,
} from './properties.js';

export type JsonConfigFile = Exclude<ConfigFile, 'server.properties'>;
type Entry = WhitelistEntry | OpEntry | BannedPlayerEntry | BannedIpEntry;
type RawEntry = Record<string, unknown>;

export interface CommandResult {
  via: 'stdin' | 'rcon';
  response?: string | undefined;
}

export interface ConfigServiceOptions {
  serverDir: string;
  isRunning: () => boolean;
  /** Envoi d'une commande console (RCON de préférence, pour la réponse). */
  exec: (command: string) => Promise<CommandResult>;
  now?: () => number;
  fetchImpl?: FetchLike | undefined;
  /** Vie privée (lot 9) : la résolution Mojang est-elle permise ? (lu à chaque action, réglage à chaud) */
  allowMojang?: () => boolean;
}

export type ConfigGetResult = ParsedResponsePayload<'config.get'>;
export type ConfigSetResult = ParsedResponsePayload<'config.set'>;
export type PlayerActionResult = ParsedResponsePayload<'player.action'>;

const FAILURE_PATTERNS = [
  /does not exist/i,
  /incorrect argument/i,
  /unknown or incomplete command/i,
  /unknown command/i,
  /could not be found/i,
  /not found/i,
  /no player was found/i,
];

/** Date au format Java du serveur : `yyyy-MM-dd HH:mm:ss Z` (offset local). */
export function formatBanDate(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function entryKey(file: JsonConfigFile, e: RawEntry): string {
  if (file === 'banned-ips.json') return `ip:${str(e.ip).trim()}`;
  const uuid = str(e.uuid).toLowerCase();
  if (uuid !== '') return `uuid:${uuid}`;
  return `name:${str(e.name).toLowerCase()}`;
}

function nameOf(e: RawEntry): string {
  return str(e.name);
}

export class ConfigService {
  private readonly now: () => number;

  constructor(private readonly options: ConfigServiceOptions) {
    this.now = options.now ?? Date.now;
  }

  private file(name: string): string {
    return path.join(this.options.serverDir, name);
  }

  private async readText(name: string): Promise<string | undefined> {
    try {
      const text = await readFile(this.file(name), 'utf8');
      return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return undefined;
      throw new ProtocolError('E_IO', error instanceof Error ? error.message : String(error), {
        details: { path: name },
      });
    }
  }

  private async readJsonEntries(file: JsonConfigFile): Promise<{ raw: RawEntry[]; text: string }> {
    const text = (await this.readText(file)) ?? '';
    if (text.trim() === '') return { raw: [], text };
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ProtocolError('E_IO', `${file} is not valid JSON`, { details: { path: file } });
    }
    const raw = Array.isArray(parsed)
      ? parsed.filter((e): e is RawEntry => typeof e === 'object' && e !== null)
      : [];
    return { raw, text };
  }

  private async onlineMode(): Promise<boolean> {
    const props = parseProperties((await this.readText('server.properties')) ?? '');
    return parseBooleanProperty(props.get('online-mode')) ?? true;
  }

  private async defaultOpLevel(): Promise<number> {
    const props = parseProperties((await this.readText('server.properties')) ?? '');
    return parseIntProperty(props.get('op-permission-level')) ?? 4;
  }

  // --- config.get -----------------------------------------------------------------------------

  async get(file: ConfigFile): Promise<ConfigGetResult> {
    if (file === 'server.properties') {
      const text = (await this.readText(file)) ?? '';
      return {
        file,
        data: Object.fromEntries(parseProperties(text)),
        sha256: sha256(text),
        source: 'file',
      };
    }
    const { raw, text } = await this.readJsonEntries(file);
    const schema = CONFIG_DATA_SCHEMAS[file];
    const data = raw
      .map((e) => schema.element.safeParse(e))
      .filter((r) => r.success)
      .map((r) => r.data);
    return { file, data, sha256: sha256(text), source: 'file' };
  }

  // --- config.set -----------------------------------------------------------------------------

  async set(file: ConfigFile, input: unknown, expectedSha256?: string): Promise<ConfigSetResult> {
    const parsed = CONFIG_SET_SCHEMAS[file].safeParse(input);
    if (!parsed.success) {
      throw new ProtocolError('E_INVALID_PAYLOAD', `invalid data for ${file}`, {
        details: { file, issues: parsed.error.issues.slice(0, 5) },
      });
    }
    if (file === 'server.properties') {
      return this.setProperties(parsed.data as Record<string, string | null>, expectedSha256);
    }
    const entries: RawEntry[] = parsed.data as Entry[];
    const { raw, text } = await this.readJsonEntries(file);
    this.checkSha(text, expectedSha256, file);
    if (this.options.isRunning()) return this.applyJsonLive(file, raw, entries);
    await this.writeJson(file, raw, entries);
    return {
      applied: 'file',
      restartRequired: false,
      sha256: sha256(await this.readTextOrEmpty(file)),
    };
  }

  private async readTextOrEmpty(file: string): Promise<string> {
    return (await this.readText(file)) ?? '';
  }

  private checkSha(text: string, expected: string | undefined, file: string): void {
    if (expected !== undefined && sha256(text) !== expected) {
      throw new ProtocolError('E_CONFLICT', 'file changed since it was read', {
        details: { path: file, sha256: sha256(text) },
      });
    }
  }

  private async setProperties(
    patch: Record<string, string | null>,
    expectedSha256: string | undefined,
  ): Promise<ConfigSetResult> {
    const text = (await this.readText('server.properties')) ?? '';
    this.checkSha(text, expectedSha256, 'server.properties');
    const next = updateProperties(text, patch);
    const { sha256: digest } = await writeAtomic(this.file('server.properties'), next);
    const running = this.options.isRunning();
    const commands: string[] = [];
    const warnings: ConfigWarning[] = [];
    if (running) {
      // Seule la liste blanche s'applique à chaud (`whitelist on/off`) ; le reste attend un redémarrage.
      const wl = parseBooleanProperty(patch['white-list'] ?? undefined);
      if (wl !== undefined) {
        const cmd = `whitelist ${wl ? 'on' : 'off'}`;
        commands.push(cmd);
        await this.run(cmd, warnings);
      }
    }
    return {
      applied: 'file',
      restartRequired: running,
      sha256: digest,
      ...(commands.length > 0 ? { commands } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  /** Serveur arrêté : écriture complète du fichier (champs inconnus des entrées existantes conservés). */
  private async writeJson(file: JsonConfigFile, current: RawEntry[], desired: RawEntry[]) {
    const existing = new Map(current.map((e) => [entryKey(file, e), e]));
    const opLevel = file === 'ops.json' ? await this.defaultOpLevel() : 4;
    const out = desired.map((e) => {
      const base = existing.get(entryKey(file, e)) ?? {};
      return this.completeEntry(file, { ...base, ...e }, opLevel);
    });
    await writeAtomic(this.file(file), `${JSON.stringify(out, null, 2)}\n`);
  }

  private completeEntry(file: JsonConfigFile, e: RawEntry, opLevel: number): RawEntry {
    switch (file) {
      case 'whitelist.json':
        return { uuid: e.uuid, name: e.name, ...omit(e, ['uuid', 'name']) };
      case 'ops.json':
        return {
          uuid: e.uuid,
          name: e.name,
          level: typeof e.level === 'number' ? e.level : opLevel,
          bypassesPlayerLimit: e.bypassesPlayerLimit === true,
          ...omit(e, ['uuid', 'name', 'level', 'bypassesPlayerLimit']),
        };
      case 'banned-players.json':
      case 'banned-ips.json': {
        const head = file === 'banned-ips.json' ? { ip: e.ip } : { uuid: e.uuid, name: e.name };
        return {
          ...head,
          created: typeof e.created === 'string' ? e.created : formatBanDate(this.now()),
          source: typeof e.source === 'string' ? e.source : 'MMO',
          expires: typeof e.expires === 'string' ? e.expires : 'forever',
          reason: typeof e.reason === 'string' ? e.reason : 'Banned by an operator.',
          ...omit(e, ['uuid', 'name', 'ip', 'created', 'source', 'expires', 'reason']),
        };
      }
    }
  }

  /** Serveur en marche : diff → commandes. */
  private async applyJsonLive(
    file: JsonConfigFile,
    current: RawEntry[],
    desired: RawEntry[],
  ): Promise<ConfigSetResult> {
    const have = new Map(current.map((e) => [entryKey(file, e), e]));
    const want = new Map(desired.map((e) => [entryKey(file, e), e]));
    const commands: string[] = [];
    const warnings: ConfigWarning[] = [];
    for (const [key, e] of want) {
      const old = have.get(key);
      if (old === undefined) {
        commands.push(...this.addCommands(file, e, warnings));
      } else if (file === 'ops.json' && e.level !== undefined && e.level !== old.level) {
        warnings.push('W_OP_LEVEL_LIVE');
      }
    }
    for (const [key, e] of have) {
      if (!want.has(key)) commands.push(this.removeCommand(file, e));
    }
    for (const cmd of commands) await this.run(cmd, warnings);
    return {
      applied: 'commands',
      restartRequired: false,
      commands,
      ...(warnings.length > 0 ? { warnings: [...new Set(warnings)] } : {}),
    };
  }

  private addCommands(file: JsonConfigFile, e: RawEntry, warnings: ConfigWarning[]): string[] {
    switch (file) {
      case 'whitelist.json':
        return [`whitelist add ${nameOf(e)}`];
      case 'ops.json':
        if (typeof e.level === 'number') warnings.push('W_OP_LEVEL_LIVE');
        return [`op ${nameOf(e)}`];
      case 'banned-players.json':
        if (typeof e.expires === 'string' && e.expires !== 'forever') {
          warnings.push('W_BAN_EXPIRES_LIVE');
        }
        return [withReason(`ban ${nameOf(e)}`, e.reason)];
      case 'banned-ips.json':
        if (typeof e.expires === 'string' && e.expires !== 'forever') {
          warnings.push('W_BAN_EXPIRES_LIVE');
        }
        return [withReason(`ban-ip ${str(e.ip)}`, e.reason)];
    }
  }

  private removeCommand(file: JsonConfigFile, e: RawEntry): string {
    switch (file) {
      case 'whitelist.json':
        return `whitelist remove ${nameOf(e)}`;
      case 'ops.json':
        return `deop ${nameOf(e)}`;
      case 'banned-players.json':
        return `pardon ${nameOf(e)}`;
      case 'banned-ips.json':
        return `pardon-ip ${str(e.ip)}`;
    }
  }

  private async run(command: string, warnings: ConfigWarning[]): Promise<string | undefined> {
    const r = await this.options.exec(command);
    if (r.response !== undefined && FAILURE_PATTERNS.some((p) => p.test(r.response ?? ''))) {
      warnings.push('W_COMMAND_FAILED');
    }
    return r.response;
  }

  // --- player.action --------------------------------------------------------------------------

  async playerAction(
    action: PlayerActionKind,
    target: string,
    reason?: string,
    level?: number,
  ): Promise<PlayerActionResult> {
    const t = target.trim();
    if (t === '' || /\s/.test(t)) {
      throw new ProtocolError('E_INVALID_PAYLOAD', 'invalid target', { details: { target } });
    }
    if (this.options.isRunning()) {
      const warnings: ConfigWarning[] = [];
      if (action === 'op' && level !== undefined) warnings.push('W_OP_LEVEL_LIVE');
      const response = await this.run(liveCommand(action, t, reason), warnings);
      return {
        applied: 'commands',
        ...(response === undefined ? {} : { response }),
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    }
    if (action === 'kick') {
      throw new ProtocolError('E_CONFLICT', 'kick requires a running server', {
        details: { reason: 'not_running', warnings: ['W_KICK_REQUIRES_RUNNING'] },
      });
    }
    const file = fileFor(action);
    const { raw } = await this.readJsonEntries(file);
    let desired: RawEntry[];
    if (action === 'banIp') {
      desired = raw.filter((e) => str(e.ip) !== t);
      desired.push({ ip: t, ...(reason === undefined ? {} : { reason }) });
    } else if (action === 'pardonIp') {
      desired = raw.filter((e) => str(e.ip) !== t);
    } else if (action === 'deop' || action === 'pardon' || action === 'whitelistRemove') {
      desired = raw.filter((e) => nameOf(e).toLowerCase() !== t.toLowerCase());
    } else {
      const [resolved] = await resolvePlayers([t], {
        serverDir: this.options.serverDir,
        onlineMode: await this.onlineMode(),
        fetchImpl: this.options.fetchImpl,
        allowMojang: this.options.allowMojang?.() ?? true,
      });
      const uuid = resolved?.uuid ?? null;
      if (resolved === undefined || uuid === null) {
        throw new ProtocolError('E_NOT_FOUND', `cannot resolve UUID of ${t}`, {
          details: { target: t, reason: 'uuid_unresolved' },
        });
      }
      desired = raw.filter(
        (e) =>
          entryKey(file, e) !== `uuid:${uuid.toLowerCase()}` &&
          nameOf(e).toLowerCase() !== t.toLowerCase(),
      );
      const entry: RawEntry = { uuid, name: resolved.name };
      if (action === 'op' && level !== undefined) entry.level = level;
      if (action === 'ban' && reason !== undefined) entry.reason = reason;
      desired.push(entry);
    }
    await this.writeJson(file, raw, desired);
    return { applied: 'file' };
  }
}

function fileFor(action: Exclude<PlayerActionKind, 'kick'>): JsonConfigFile {
  switch (action) {
    case 'ban':
    case 'pardon':
      return 'banned-players.json';
    case 'banIp':
    case 'pardonIp':
      return 'banned-ips.json';
    case 'op':
    case 'deop':
      return 'ops.json';
    case 'whitelistAdd':
    case 'whitelistRemove':
      return 'whitelist.json';
  }
}

function liveCommand(action: PlayerActionKind, target: string, reason?: string): string {
  switch (action) {
    case 'kick':
      return withReason(`kick ${target}`, reason);
    case 'ban':
      return withReason(`ban ${target}`, reason);
    case 'pardon':
      return `pardon ${target}`;
    case 'banIp':
      return withReason(`ban-ip ${target}`, reason);
    case 'pardonIp':
      return `pardon-ip ${target}`;
    case 'op':
      return `op ${target}`;
    case 'deop':
      return `deop ${target}`;
    case 'whitelistAdd':
      return `whitelist add ${target}`;
    case 'whitelistRemove':
      return `whitelist remove ${target}`;
  }
}

function withReason(command: string, reason: unknown): string {
  const r = typeof reason === 'string' ? reason.replace(/[\r\n]+/g, ' ').trim() : '';
  return r === '' ? command : `${command} ${r}`;
}

function omit(e: RawEntry, keys: string[]): RawEntry {
  const out: RawEntry = {};
  for (const [k, v] of Object.entries(e)) if (!keys.includes(k)) out[k] = v;
  return out;
}
