/**
 * Complétion de la console, sur le MÊME modèle que la découverte serveur (`@mmo/shared`).
 *
 * Le catalogue écrit ici n'est plus qu'un repli : il sert quand le serveur est arrêté, quand
 * l'agent est trop ancien pour être interrogé, ou pendant les quelques centaines de millisecondes
 * qui précèdent la réponse. Dès que le serveur a répondu, c'est LUI qui fait autorité — sur un
 * modpack, aucune table écrite à la main ne peut être juste.
 *
 * Le catalogue est exprimé en lignes d'usage plutôt qu'en listes de mots : c'est ce qui permet de
 * compléter à n'importe quelle position (« time set … » se complète au 3ᵉ mot, ce dont l'ancienne
 * table était incapable puisqu'elle stockait « set day » comme une seule chaîne).
 */
import {
  argKind,
  expectsPlayerAt,
  formatUsage,
  matchingUsages,
  specsFromUsageLines,
  suggestionsAt,
  type ArgKind,
  type CommandSpec,
} from '@mmo/shared';

/** Commandes vanilla, en lignes d'usage. Incomplet par nature — c'est un repli, pas une vérité. */
const VANILLA_USAGES = [
  'advancement (grant|revoke) <targets>',
  'attribute <target> <attribute>',
  'ban <targets> [<reason...>]',
  'ban-ip <target> [<reason...>]',
  'banlist (players|ips)',
  'bossbar (add|remove|list|set|get)',
  'clear [<targets>]',
  'clone <begin> <end> <destination>',
  'damage <target> <amount>',
  'data (get|merge|modify|remove)',
  'datapack (list|enable|disable)',
  'debug (start|stop|function)',
  'defaultgamemode (survival|creative|adventure|spectator)',
  'deop <targets>',
  'difficulty (peaceful|easy|normal|hard)',
  'effect (give|clear) <targets> [<effect>]',
  'enchant <targets> <enchantment> [<level>]',
  'execute ...',
  'experience (add|set|query) <targets> [<amount>]',
  'fill <from> <to> <block>',
  'forceload (add|remove|query)',
  'function <name>',
  'gamemode (survival|creative|adventure|spectator) [<targets>]',
  'gamerule <rule> [<value>]',
  'give <targets> <item> [<count>]',
  'help [<command>]',
  'item (replace|modify)',
  'kick <targets> [<reason...>]',
  'kill [<targets>]',
  'list [uuids]',
  'locate (structure|biome|poi) <name>',
  'loot (give|insert|spawn|replace)',
  'me <message...>',
  'msg <targets> <message...>',
  'op <targets>',
  'pardon <targets>',
  'pardon-ip <target>',
  'particle <name> [<pos>]',
  'place (feature|jigsaw|structure|template)',
  'playsound <sound> <source> <targets>',
  'reload',
  'ride <target> (mount|dismount)',
  'save-all [flush]',
  'save-off',
  'save-on',
  'say <message...>',
  'schedule (function|clear)',
  'scoreboard (objectives|players)',
  'seed',
  'setblock <pos> <block> [destroy|keep|replace]',
  'setworldspawn [<pos>]',
  'spawnpoint [<targets>] [<pos>]',
  'spectate [<target>]',
  'spreadplayers <center> <spreadDistance> <maxRange> <respectTeams> <targets>',
  'stop',
  'stopsound <targets>',
  'summon <entity> [<pos>]',
  'tag <targets> (add|remove|list)',
  'team (list|add|remove|empty|join|leave|modify)',
  'teleport <targets> [<destination>]',
  'tell <targets> <message...>',
  'tellraw <targets> <component>',
  'tick (query|rate|freeze|unfreeze|step|sprint)',
  'time (set|add|query) <value>',
  'time set (day|night|noon|midnight)',
  'title <targets> (title|subtitle|actionbar|clear|reset)',
  'tp <targets> [<destination>]',
  'trigger <objective>',
  'weather (clear|rain|thunder) [<duration>]',
  'whitelist (on|off|list|reload)',
  'whitelist (add|remove) <targets>',
  'worldborder (add|set|center|damage|get|warning)',
  'xp (add|set|query) <targets> [<amount>]',
] as const;

const LOADER_USAGES: Record<string, readonly string[]> = {
  forge: ['forge (tps|mods|track|generate|dimensions)', 'forge entity (list|kill)'],
  neoforge: ['neoforge (tps|mods|track|generate|dimensions)', 'neoforge entity (list|kill)'],
  fabric: ['fabric (mods|version)'],
  vanilla: [],
  unknown: [],
};

/** Repli mis en cache par loader : le parsing des lignes ne se refait pas à chaque frappe. */
const fallbackCache = new Map<string, CommandSpec[]>();

export function fallbackSpecs(loader?: string): CommandSpec[] {
  const key = loader ?? 'unknown';
  const cached = fallbackCache.get(key);
  if (cached) return cached;
  const specs = specsFromUsageLines([...VANILLA_USAGES, ...(LOADER_USAGES[key] ?? [])]);
  fallbackCache.set(key, specs);
  return specs;
}

/** Ce que la liste propose : un texte à insérer, un libellé, et de quoi l'expliquer. */
export interface Suggestion {
  /** Ligne complète une fois la proposition acceptée. */
  insert: string;
  /** Ce qui s'affiche dans la liste (le mot seul, pas la ligne entière). */
  label: string;
  kind: 'command' | 'value' | 'player';
}

export interface CompletionContext {
  loader?: string;
  players?: readonly string[];
  /** Commandes découvertes chez le serveur ; prioritaires sur le repli. */
  discovered?: readonly CommandSpec[];
  /** Verbes déjà tapés par l'utilisateur, du plus récent au plus ancien. */
  history?: readonly string[];
}

/** Découpe respectant les guillemets : `say "bonjour tout le monde"` fait deux mots. */
export function tokenize(line: string): { words: string[]; trailingSpace: boolean } {
  const words: string[] = [];
  let current = '';
  let quote: string | undefined;
  for (const ch of line) {
    if (quote !== undefined) {
      current += ch;
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ' ') {
      if (current !== '') words.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current !== '') words.push(current);
  return { words, trailingSpace: line.endsWith(' ') };
}

function specsFor(ctx: CompletionContext): CommandSpec[] {
  // Le serveur fait autorité dès qu'il a parlé : sur un modpack, la table locale est fausse.
  return ctx.discovered !== undefined && ctx.discovered.length > 0
    ? [...ctx.discovered]
    : fallbackSpecs(ctx.loader);
}

/** Rang d'un verbe dans l'historique (petit = récent) ; `Infinity` s'il n'y figure pas. */
function historyRank(history: readonly string[] | undefined, name: string): number {
  if (!history) return Infinity;
  const i = history.indexOf(name);
  return i === -1 ? Infinity : i;
}

/**
 * Propositions pour la saisie courante. Le préfixe `/` est toléré et restitué.
 * Ne propose jamais rien qui exécute : accepter une proposition ne fait que remplir le champ.
 */
export function complete(input: string, ctx: CompletionContext = {}, limit = 8): Suggestion[] {
  const slash = input.startsWith('/');
  const raw = slash ? input.slice(1) : input;
  const { words, trailingSpace } = tokenize(raw);
  const specs = specsFor(ctx);
  const prefix = (s: string) => (slash ? `/${s}` : s);

  // Premier mot : la commande elle-même.
  if (words.length <= 1 && !trailingSpace) {
    const typed = (words[0] ?? '').toLowerCase();
    return specs
      .filter((s) => s.name.startsWith(typed))
      .sort(
        (a, b) =>
          // Ce que l'utilisateur tape souvent d'abord — mais jamais au point de mettre `stop`
          // en tête au premier caractère : le classement ne joue qu'à préfixe égal.
          historyRank(ctx.history, a.name) - historyRank(ctx.history, b.name) ||
          a.name.localeCompare(b.name),
      )
      .slice(0, limit)
      .map((s) => ({ insert: prefix(s.name), label: s.name, kind: 'command' as const }));
  }

  const name = (words[0] ?? '').toLowerCase();
  const spec = specs.find((s) => s.name === name);
  if (!spec) return [];
  // Le mot en cours de frappe est exclu des mots « terminés ».
  const current = trailingSpace ? '' : (words[words.length - 1] ?? '');
  const typed = trailingSpace ? words.slice(1) : words.slice(1, -1);
  const head = [words[0], ...typed].join(' ');
  const lower = current.toLowerCase();

  const values = suggestionsAt(spec, typed).map((v) => ({ value: v, kind: 'value' as const }));
  const players = expectsPlayerAt(spec, typed)
    ? (ctx.players ?? []).map((p) => ({ value: p, kind: 'player' as const }))
    : [];
  return [...values, ...players]
    .filter((c) => c.value.toLowerCase().startsWith(lower) && c.value.toLowerCase() !== lower)
    .slice(0, limit)
    .map((c) => ({ insert: prefix(`${head} ${c.value}`), label: c.value, kind: c.kind }));
}

/** Ce que l'aperçu affiche sous le champ. */
export interface SignatureView {
  name: string;
  /** Usages compatibles avec ce qui est tapé, en texte. */
  usages: string[];
  /** Nombre d'usages non affichés. */
  more: number;
  /** Type de l'argument attendu maintenant, pour une aide d'une ligne. */
  expects?: ArgKind;
  /** L'arbre de cette commande n'est pas déplié : l'aperçu est partiel. */
  partial: boolean;
  description?: string;
}

const MAX_SHOWN_USAGES = 3;

/** Aperçu de la commande en cours de frappe ; `undefined` si rien de reconnu. */
export function signature(
  input: string,
  ctx: CompletionContext = {},
  maxUsages = MAX_SHOWN_USAGES,
): SignatureView | undefined {
  const raw = input.startsWith('/') ? input.slice(1) : input;
  const { words, trailingSpace } = tokenize(raw);
  if (words.length === 0) return undefined;
  // Tant que le premier mot est en cours de frappe, il n'y a pas encore de commande à décrire.
  if (words.length === 1 && !trailingSpace) return undefined;
  const spec = specsFor(ctx).find((s) => s.name === (words[0] ?? '').toLowerCase());
  if (!spec) return undefined;
  const typed = trailingSpace ? words.slice(1) : words.slice(1, -1);
  const matches = matchingUsages(spec, typed);
  const shown = (matches.length > 0 ? matches : spec.usages.map((usage) => ({ usage, at: 0 })))
    .slice(0, maxUsages)
    .map(({ usage }) => formatUsage(usage));
  const expected = matches.map(({ usage, at }) => usage[at]).find((t) => t?.kind === 'argument');
  const kind = expected?.kind === 'argument' ? argKind(expected.name) : undefined;
  return {
    name: spec.name,
    usages: shown,
    more: Math.max(0, (matches.length > 0 ? matches.length : spec.usages.length) - shown.length),
    ...(kind === undefined ? {} : { expects: kind }),
    partial: !spec.deep,
    ...(spec.description === undefined ? {} : { description: spec.description }),
  };
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

/** Verbes de l'historique, du plus récent au plus ancien, sans doublon. */
export function recentVerbs(history: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const verb = (history[i] ?? '').replace(/^\//, '').split(' ')[0]?.toLowerCase() ?? '';
    // Le verbe seul, jamais la ligne entière : elle contient des pseudos de joueurs partis.
    if (verb === '' || seen.has(verb)) continue;
    seen.add(verb);
    out.push(verb);
  }
  return out;
}
