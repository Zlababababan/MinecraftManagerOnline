/**
 * Autocomplétion V1 de la console : commandes vanilla courantes + commandes de loaders, et
 * noms des joueurs en ligne pour les arguments. Historique ↑/↓ (local + `command-history`).
 */
export const VANILLA_COMMANDS = [
  'ban',
  'ban-ip',
  'banlist',
  'bossbar',
  'clear',
  'clone',
  'data',
  'datapack',
  'debug',
  'defaultgamemode',
  'deop',
  'difficulty',
  'effect',
  'enchant',
  'execute',
  'experience',
  'fill',
  'forceload',
  'function',
  'gamemode',
  'gamerule',
  'give',
  'help',
  'kick',
  'kill',
  'list',
  'locate',
  'me',
  'msg',
  'op',
  'pardon',
  'pardon-ip',
  'particle',
  'playsound',
  'reload',
  'save-all',
  'save-off',
  'save-on',
  'say',
  'schedule',
  'scoreboard',
  'seed',
  'setblock',
  'setworldspawn',
  'spawnpoint',
  'spreadplayers',
  'stop',
  'stopsound',
  'summon',
  'tag',
  'team',
  'teleport',
  'tell',
  'tellraw',
  'time',
  'title',
  'tp',
  'trigger',
  'weather',
  'whitelist',
  'worldborder',
  'xp',
] as const;

export const LOADER_COMMANDS: Record<string, readonly string[]> = {
  forge: ['forge'],
  neoforge: ['neoforge'],
  fabric: ['fabric'],
  vanilla: [],
  unknown: [],
};

const SUBCOMMANDS: Record<string, readonly string[]> = {
  whitelist: ['add', 'remove', 'list', 'on', 'off', 'reload'],
  gamemode: ['survival', 'creative', 'adventure', 'spectator'],
  time: ['set day', 'set night', 'set noon', 'add', 'query'],
  weather: ['clear', 'rain', 'thunder'],
  difficulty: ['peaceful', 'easy', 'normal', 'hard'],
  forge: ['tps', 'entity list', 'mods', 'track'],
  neoforge: ['tps', 'entity list', 'mods'],
  banlist: ['players', 'ips'],
};

const PLAYER_ARG_COMMANDS = new Set([
  'kick',
  'ban',
  'pardon',
  'op',
  'deop',
  'tp',
  'teleport',
  'msg',
  'tell',
  'kill',
  'gamemode',
  'give',
  'xp',
  'experience',
  'effect',
  'clear',
  'enchant',
]);

export interface CompletionContext {
  loader?: string;
  players?: readonly string[];
}

/** Propositions pour le texte courant (préfixe `/` toléré) — au plus `limit` résultats triés. */
export function complete(input: string, ctx: CompletionContext = {}, limit = 8): string[] {
  const raw = input.startsWith('/') ? input.slice(1) : input;
  const parts = raw.split(' ');
  const first = (parts[0] ?? '').toLowerCase();
  if (parts.length === 1) {
    const all = [...VANILLA_COMMANDS, ...(LOADER_COMMANDS[ctx.loader ?? ''] ?? [])];
    return all
      .filter((c) => c.startsWith(first))
      .sort()
      .slice(0, limit)
      .map((c) => (input.startsWith('/') ? `/${c}` : c));
  }
  const current = parts[parts.length - 1] ?? '';
  const head = parts.slice(0, -1).join(' ');
  const candidates: string[] = [];
  if (parts.length === 2) {
    for (const sub of SUBCOMMANDS[first] ?? []) candidates.push(sub);
  }
  if (parts.length >= 2 && (PLAYER_ARG_COMMANDS.has(first) || first === 'whitelist')) {
    for (const p of ctx.players ?? []) candidates.push(p);
  }
  const lower = current.toLowerCase();
  return [...new Set(candidates)]
    .filter((c) => c.toLowerCase().startsWith(lower) && c.toLowerCase() !== lower)
    .sort()
    .slice(0, limit)
    .map((c) => `${head} ${c}`);
}

/** Historique de commandes : navigation ↑/↓ avec brouillon conservé. */
export class CommandHistory {
  private entries: string[];
  private index: number;
  private draft = '';

  constructor(
    initial: readonly string[] = [],
    private readonly max = 200,
  ) {
    this.entries = [...initial].slice(-max);
    this.index = this.entries.length;
  }

  get all(): readonly string[] {
    return this.entries;
  }

  /** Amorce (historique serveur, plus ancien en premier) placée avant les entrées locales. */
  seed(initial: readonly string[]): void {
    this.entries = [...initial, ...this.entries].slice(-this.max);
    this.index = this.entries.length;
  }

  push(command: string): void {
    if (command.trim() === '') return;
    if (this.entries[this.entries.length - 1] !== command) {
      this.entries.push(command);
      if (this.entries.length > this.max) this.entries.shift();
    }
    this.index = this.entries.length;
    this.draft = '';
  }

  /** ↑ : entrée précédente (conserve le brouillon en cours). */
  up(current: string): string | undefined {
    if (this.entries.length === 0) return undefined;
    if (this.index === this.entries.length) this.draft = current;
    if (this.index > 0) this.index -= 1;
    return this.entries[this.index];
  }

  /** ↓ : entrée suivante, puis retour au brouillon. */
  down(): string | undefined {
    if (this.index >= this.entries.length) return undefined;
    this.index += 1;
    return this.index === this.entries.length ? this.draft : this.entries[this.index];
  }
}
