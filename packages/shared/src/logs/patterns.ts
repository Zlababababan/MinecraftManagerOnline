/**
 * Événements serveur reconnus dans les messages de log (doc 06 §4–6). Les regex sont volontairement
 * souples : le nombre de `Done (5,3s)!` suit la locale JVM (virgule possible — spike n°1) et le
 * « For help » n'est pas exigé.
 */

export const DONE_REGEX = /Done \(([\d.,]+)\s*s\)!/;
export const STARTING_VERSION_REGEX = /Starting minecraft server version (\S+)/;
export const FABRIC_LOADING_REGEX = /Loading Minecraft (\S+) with Fabric Loader (\S+)/;
export const FORGE_LEGACY_REGEX = /Forge Mod Loader version (\S+) for Minecraft (\S+) loading/;
export const MODLAUNCHER_MC_REGEX = /--fml\.mcVersion, ([^\],\s]+)/;
export const MODLAUNCHER_FORGE_REGEX = /--fml\.forgeVersion, ([^\],\s]+)/;
export const MODLAUNCHER_NEOFORGE_REGEX = /--fml\.neoForgeVersion, ([^\],\s]+)/;
export const PREPARING_SPAWN_REGEX = /Preparing spawn area: (\d+)%/;
export const LISTENING_REGEX = /Starting Minecraft server on (\S+):(\d+)/;
export const RCON_RUNNING_REGEX = /RCON running on (\S+):(\d+)/;
export const EULA_REQUIRED_REGEX = /You need to agree to the EULA/;
export const STOPPING_REGEX = /^Stopping (?:the )?server$/;
export const PLAYER_JOIN_REGEX = /^(\S+) joined the game$/;
export const PLAYER_LEAVE_REGEX = /^(\S+) left the game$/;
export const PLAYER_LOGIN_REGEX = /^(\S+)\[\/(.+?)\] logged in with entity id (\d+)/;
export const PLAYER_UUID_REGEX = /UUID of player (\S+) is ([0-9a-f-]{36})/i;
export const PLAYER_DISCONNECT_REGEX = /^(\S+) lost connection: (.*)$/;
export const BIND_FAILED_REGEX = /FAILED TO BIND TO PORT/i;
export const CANT_KEEP_UP_REGEX =
  /Can't keep up! Is the server overloaded\? Running (\d+)ms or (\d+) ticks behind/;
export const CRASH_REGEXES: readonly { code: string; regex: RegExp }[] = [
  { code: 'unexpected_exception', regex: /Encountered an unexpected exception/ },
  { code: 'tick_loop_exception', regex: /Exception in server tick loop/ },
  { code: 'out_of_memory', regex: /java\.lang\.OutOfMemoryError/ },
  { code: 'watchdog_tick', regex: /A single server tick took (\d+\.\d+) seconds/ },
];

export type ServerLogEvent =
  | { kind: 'done'; seconds: number }
  | { kind: 'starting'; mcVersion: string }
  | { kind: 'fabric_loading'; mcVersion: string; loaderVersion: string }
  | { kind: 'forge_legacy_loading'; mcVersion: string; loaderVersion: string }
  | {
      kind: 'modlauncher';
      mcVersion: string | undefined;
      forgeVersion: string | undefined;
      neoForgeVersion: string | undefined;
    }
  | { kind: 'preparing_spawn'; percent: number }
  | { kind: 'listening'; host: string; port: number }
  | { kind: 'rcon_running'; host: string; port: number }
  | { kind: 'eula_required' }
  | { kind: 'stopping' }
  | { kind: 'player_join'; name: string }
  | { kind: 'player_leave'; name: string }
  | { kind: 'player_login'; name: string; address: string; entityId: number }
  | { kind: 'player_uuid'; name: string; uuid: string }
  | { kind: 'player_disconnect'; name: string; reason: string }
  | { kind: 'cant_keep_up'; behindMs: number; behindTicks: number }
  /** Port de jeu déjà pris (`**** FAILED TO BIND TO PORT!`) : conflit de port, pas un crash. */
  | { kind: 'bind_failed' }
  | { kind: 'crash_signal'; code: string };

/** Reconnaît un événement serveur dans un message de log (sans son en-tête). */
export function matchServerLogEvent(message: string): ServerLogEvent | undefined {
  let m: RegExpExecArray | null;
  if ((m = DONE_REGEX.exec(message))) {
    return { kind: 'done', seconds: Number((m[1] ?? '0').replace(',', '.')) };
  }
  if ((m = STARTING_VERSION_REGEX.exec(message)))
    return { kind: 'starting', mcVersion: m[1] ?? '' };
  if ((m = FABRIC_LOADING_REGEX.exec(message))) {
    return { kind: 'fabric_loading', mcVersion: m[1] ?? '', loaderVersion: m[2] ?? '' };
  }
  if ((m = FORGE_LEGACY_REGEX.exec(message))) {
    return { kind: 'forge_legacy_loading', mcVersion: m[2] ?? '', loaderVersion: m[1] ?? '' };
  }
  if (message.includes('--fml.mcVersion')) {
    return {
      kind: 'modlauncher',
      mcVersion: MODLAUNCHER_MC_REGEX.exec(message)?.[1],
      forgeVersion: MODLAUNCHER_FORGE_REGEX.exec(message)?.[1],
      neoForgeVersion: MODLAUNCHER_NEOFORGE_REGEX.exec(message)?.[1],
    };
  }
  if ((m = PREPARING_SPAWN_REGEX.exec(message)))
    return { kind: 'preparing_spawn', percent: Number(m[1]) };
  if ((m = LISTENING_REGEX.exec(message)))
    return { kind: 'listening', host: m[1] ?? '', port: Number(m[2]) };
  if ((m = RCON_RUNNING_REGEX.exec(message)))
    return { kind: 'rcon_running', host: m[1] ?? '', port: Number(m[2]) };
  if (message.includes('You need to agree to the EULA')) return { kind: 'eula_required' };
  if (STOPPING_REGEX.test(message)) return { kind: 'stopping' };
  if ((m = PLAYER_JOIN_REGEX.exec(message))) return { kind: 'player_join', name: m[1] ?? '' };
  if ((m = PLAYER_LEAVE_REGEX.exec(message))) return { kind: 'player_leave', name: m[1] ?? '' };
  if ((m = PLAYER_LOGIN_REGEX.exec(message))) {
    return { kind: 'player_login', name: m[1] ?? '', address: m[2] ?? '', entityId: Number(m[3]) };
  }
  if ((m = PLAYER_UUID_REGEX.exec(message)))
    return { kind: 'player_uuid', name: m[1] ?? '', uuid: m[2] ?? '' };
  if ((m = PLAYER_DISCONNECT_REGEX.exec(message))) {
    return { kind: 'player_disconnect', name: m[1] ?? '', reason: m[2] ?? '' };
  }
  if ((m = CANT_KEEP_UP_REGEX.exec(message))) {
    return { kind: 'cant_keep_up', behindMs: Number(m[1]), behindTicks: Number(m[2]) };
  }
  if (BIND_FAILED_REGEX.test(message)) return { kind: 'bind_failed' };
  for (const { code, regex } of CRASH_REGEXES) {
    if (regex.test(message)) return { kind: 'crash_signal', code };
  }
  return undefined;
}
