/**
 * Modèle des commandes d'un serveur Minecraft, et lecture de la sortie de `/help`.
 *
 * Pourquoi lire le serveur plutôt que d'écrire une table : le parc réel va de la 1.12 à la 1.21,
 * en Forge, NeoForge, Fabric et vanilla, avec des centaines de commandes ajoutées par les mods.
 * Une table écrite à la main serait fausse dans les deux sens — elle proposerait des commandes
 * absentes et ignorerait celles qui comptent vraiment sur un modpack. Depuis la 1.13, `/help`
 * imprime une ligne d'usage par commande, produite par l'arbre Brigadier du serveur lui-même,
 * mods compris ; avant, il rend le même genre de lignes, paginées.
 *
 * Ce module ne fait AUCUNE entrée-sortie : il transforme du texte en modèle. Le texte vient d'un
 * serveur tiers, donc le parseur est TOTAL — il jette ce qu'il ne comprend pas et ne lève jamais.
 */

/** Un morceau d'une ligne d'usage. */
export type UsageToken =
  /** Mot fixe à taper tel quel (`whitelist`, `add`). */
  | { kind: 'literal'; value: string }
  /** Choix fermé (`(add|remove|list)`) : les valeurs sont proposables. */
  | { kind: 'alternatives'; values: readonly string[]; optional?: boolean }
  /** Valeur libre (`<player>`, `[<targets>]`) : le type oriente l'aide affichée. */
  | { kind: 'argument'; name: string; optional?: boolean; greedy?: boolean }
  /** `...` de Brigadier : sous-arbre non déplié, il faut demander `help <commande>`. */
  | { kind: 'ellipsis' };

export type CommandUsage = readonly UsageToken[];

export interface CommandSpec {
  /** Nom de la commande racine, sans `/`. */
  name: string;
  usages: readonly CommandUsage[];
  /** `false` tant qu'un `...` subsiste : l'arbre complet demande un `help <name>`. */
  deep: boolean;
  /** Description libre rendue par certains serveurs après un tiret (1.12, Bukkit). */
  description?: string;
}

/** Bornes : la réponse vient d'un serveur arbitraire, elle ne doit pas pouvoir noyer le panel. */
export const HELP_LIMITS = {
  maxLines: 4000,
  maxLineLength: 512,
  maxUsagesPerCommand: 40,
  maxTokensPerUsage: 40,
  maxPages: 30,
} as const;

/** Codes couleur Minecraft et caractères de contrôle. */
function clean(line: string): string {
  return line
    .replace(/§./gu, '')
    .replace(/\p{Cc}/gu, ' ')
    .trim();
}

/**
 * Types d'argument reconnus, tirés du nom entre chevrons. Volontairement court : c'est le
 * vocabulaire que l'interface sait expliquer, tout le reste s'affiche tel quel.
 */
export const ARG_KINDS = [
  'player',
  'targets',
  'position',
  'item',
  'block',
  'entity',
  'effect',
  'enchantment',
  'duration',
  'amount',
  'message',
  'json',
  'dimension',
  'gamerule',
] as const;
export type ArgKind = (typeof ARG_KINDS)[number];

const KIND_BY_NAME: Readonly<Record<string, ArgKind>> = {
  player: 'player',
  players: 'player',
  name: 'player',
  target: 'targets',
  targets: 'targets',
  entity: 'entity',
  entities: 'entity',
  pos: 'position',
  position: 'position',
  location: 'position',
  destination: 'position',
  item: 'item',
  block: 'block',
  effect: 'effect',
  enchantment: 'enchantment',
  seconds: 'duration',
  duration: 'duration',
  amount: 'amount',
  count: 'amount',
  level: 'amount',
  levels: 'amount',
  value: 'amount',
  message: 'message',
  reason: 'message',
  nbt: 'json',
  component: 'json',
  dimension: 'dimension',
  rule: 'gamerule',
};

/** Type d'un argument d'après son nom ; `undefined` si le nom n'est pas du vocabulaire connu. */
export function argKind(name: string): ArgKind | undefined {
  // Brigadier écrit parfois `<targets: entity>` : le nom utile est en tête.
  const head = name.split(':')[0]?.trim().toLowerCase() ?? '';
  return KIND_BY_NAME[head];
}

const OPENERS = ' [<(';

function nextBoundary(text: string, from: number): number {
  let i = from;
  while (i < text.length && !OPENERS.includes(text[i] ?? '')) i += 1;
  return i;
}

/** Fin du groupe ouvert à `open`, en tenant compte d'un niveau d'imbrication. */
function matchingClose(text: string, open: number, opener: string, closer: string): number {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const c = text[i];
    if (c === opener) depth += 1;
    else if (c === closer) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitAlternatives(inner: string): string[] {
  return inner
    .split('|')
    .map((v) => v.trim())
    .filter((v) => v !== '');
}

function argumentToken(inner: string, optional: boolean): UsageToken | undefined {
  const name = inner.trim();
  if (name === '') return undefined;
  const greedy = name.endsWith('...');
  const bare = greedy ? name.slice(0, -3).trim() : name;
  if (bare === '') return undefined;
  return {
    kind: 'argument',
    name: bare,
    ...(optional ? { optional: true } : {}),
    ...(greedy ? { greedy: true } : {}),
  };
}

function tokenFromGroup(opener: string, inner: string): UsageToken | undefined {
  if (inner === '') return undefined;
  if (opener === '(') {
    const values = splitAlternatives(inner);
    return values.length === 0 ? undefined : { kind: 'alternatives', values };
  }
  if (opener === '<') return argumentToken(inner, false);
  // Crochets : facultatif, et le contenu peut lui-même être un argument ou un choix.
  const body = inner.trim();
  if (body.startsWith('<') && body.endsWith('>')) return argumentToken(body.slice(1, -1), true);
  if (body.startsWith('(') && body.endsWith(')')) {
    const values = splitAlternatives(body.slice(1, -1));
    return values.length === 0 ? undefined : { kind: 'alternatives', values, optional: true };
  }
  if (body.includes('|')) {
    const values = splitAlternatives(body);
    return values.length === 0 ? undefined : { kind: 'alternatives', values, optional: true };
  }
  return argumentToken(body, true);
}

/**
 * Analyse une ligne d'usage (sans le nom de commande) en une suite de tokens.
 * `undefined` si la ligne est inexploitable — mieux vaut ne rien afficher qu'un aperçu faux.
 */
export function parseUsageBody(body: string): CommandUsage | undefined {
  const tokens: UsageToken[] = [];
  const text = body.trim();
  let i = 0;
  while (i < text.length) {
    if (tokens.length > HELP_LIMITS.maxTokensPerUsage) return undefined;
    const ch = text[i] ?? '';
    if (ch === ' ') {
      i += 1;
      continue;
    }
    if (ch === '.') {
      if (text.startsWith('...', i)) {
        tokens.push({ kind: 'ellipsis' });
        i += 3;
        continue;
      }
      return undefined;
    }
    if (ch === '[' || ch === '<' || ch === '(') {
      const closer = ch === '[' ? ']' : ch === '<' ? '>' : ')';
      const end = matchingClose(text, i, ch, closer);
      if (end === -1) return undefined;
      const token = tokenFromGroup(ch, text.slice(i + 1, end).trim());
      if (!token) return undefined;
      tokens.push(token);
      i = end + 1;
      continue;
    }
    const end = nextBoundary(text, i);
    const word = text.slice(i, end);
    i = end;
    if (word === '') return undefined;
    if (word.includes('|')) tokens.push({ kind: 'alternatives', values: splitAlternatives(word) });
    else tokens.push({ kind: 'literal', value: word });
  }
  return tokens;
}

/** Une ligne `/cmd usage` (avec description éventuelle) devient une spécification à un usage. */
export function parseHelpLine(line: string): CommandSpec | undefined {
  if (!line.startsWith('/')) return undefined;
  // La description de la 1.12 suit un tiret entouré d'espaces ; les usages Brigadier n'en ont pas.
  const dash = line.indexOf(' - ');
  const usagePart = (dash === -1 ? line : line.slice(0, dash)).trim();
  const description = dash === -1 ? undefined : line.slice(dash + 3).trim();
  const space = usagePart.indexOf(' ');
  const name = (space === -1 ? usagePart.slice(1) : usagePart.slice(1, space)).trim();
  if (name === '' || !/^[a-z0-9_:-]+$/iu.test(name)) return undefined;
  const usage = parseUsageBody(space === -1 ? '' : usagePart.slice(space + 1));
  if (usage === undefined) return undefined;
  return {
    name: name.toLowerCase(),
    usages: [usage],
    deep: !usage.some((t) => t.kind === 'ellipsis'),
    ...(description === undefined || description === '' ? {} : { description }),
  };
}

export interface HelpParseResult {
  specs: CommandSpec[];
  /** Nombre total de pages annoncé par un serveur 1.12. */
  pages?: number;
  /** Des lignes ont été ignorées faute de place. */
  truncated: boolean;
}

const PAGE_RE = /help page\s+(\d+)\s+of\s+(\d+)/iu;

/**
 * Lit la sortie brute de `/help` (ou `/help <commande>`) et en tire des spécifications.
 *
 * Deux dialectes cohabitent : la 1.12 rend `/gamemode <mode> [player]`, parfois suivi d'une
 * description, la 1.13+ rend l'usage Brigadier `/gamemode (survival|creative|…) [<targets>]`.
 * Les deux se ramènent au même modèle.
 */
export function parseHelpOutput(raw: string): HelpParseResult {
  const lines = raw.split(/\r?\n/u);
  const truncated = lines.length > HELP_LIMITS.maxLines;
  const byName = new Map<string, CommandSpec>();
  let pages: number | undefined;
  for (const rawLine of lines.slice(0, HELP_LIMITS.maxLines)) {
    if (rawLine.length > HELP_LIMITS.maxLineLength) continue;
    const line = clean(rawLine);
    if (line === '') continue;
    const page = PAGE_RE.exec(line);
    if (page) {
      const total = Number(page[2]);
      if (Number.isFinite(total) && total > 0) pages = Math.min(total, HELP_LIMITS.maxPages);
      continue;
    }
    const entry = parseHelpLine(line);
    if (!entry) continue;
    const existing = byName.get(entry.name);
    if (!existing) {
      byName.set(entry.name, entry);
      continue;
    }
    if (existing.usages.length >= HELP_LIMITS.maxUsagesPerCommand) continue;
    byName.set(entry.name, {
      ...existing,
      usages: [...existing.usages, ...entry.usages],
      deep: existing.deep && entry.deep,
      ...(existing.description === undefined && entry.description !== undefined
        ? { description: entry.description }
        : {}),
    });
  }
  return {
    specs: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
    ...(pages === undefined ? {} : { pages }),
    truncated,
  };
}

/**
 * Construit des spécifications depuis des lignes écrites à la main (`gamemode (survival|…)`).
 * Sert au catalogue de repli : une seule représentation en aval, qu'elle vienne du serveur ou
 * d'une table, donc un seul moteur de complétion et un seul rendu.
 */
export function specsFromUsageLines(lines: readonly string[]): CommandSpec[] {
  return parseHelpOutput(lines.map((l) => (l.startsWith('/') ? l : `/${l}`)).join('\n')).specs;
}

/**
 * Les usages compatibles avec les mots déjà saisis, et la position atteinte dans chacun.
 * `typed` ne contient que les mots TERMINÉS : celui en cours de frappe en est exclu.
 */
export function matchingUsages(
  spec: CommandSpec,
  typed: readonly string[],
): { usage: CommandUsage; at: number }[] {
  const out: { usage: CommandUsage; at: number }[] = [];
  for (const usage of spec.usages) {
    let index = 0;
    let ok = true;
    for (const word of typed) {
      const token = usage[index];
      if (!token) {
        // Plus rien à consommer : seul un argument glouton absorbe la suite.
        const last = usage[usage.length - 1];
        ok = last?.kind === 'argument' && last.greedy === true;
        break;
      }
      if (token.kind === 'literal' && token.value.toLowerCase() !== word.toLowerCase()) {
        ok = false;
        break;
      }
      if (
        token.kind === 'alternatives' &&
        !token.values.some((v) => v.toLowerCase() === word.toLowerCase())
      ) {
        ok = false;
        break;
      }
      if (token.kind === 'argument' && token.greedy === true) break;
      index += 1;
    }
    if (ok) out.push({ usage, at: Math.min(index, usage.length) });
  }
  return out;
}

/** Valeurs proposables à la position courante (littéraux et choix fermés seulement). */
export function suggestionsAt(spec: CommandSpec, typed: readonly string[]): string[] {
  const values = new Set<string>();
  for (const { usage, at } of matchingUsages(spec, typed)) {
    const token = usage[at];
    if (!token) continue;
    if (token.kind === 'literal') values.add(token.value);
    else if (token.kind === 'alternatives') for (const v of token.values) values.add(v);
  }
  return [...values].sort((a, b) => a.localeCompare(b));
}

/** Le mot attendu à la position courante est-il un joueur ? (alimente la liste des connectés) */
export function expectsPlayerAt(spec: CommandSpec, typed: readonly string[]): boolean {
  return matchingUsages(spec, typed).some(({ usage, at }) => {
    const token = usage[at];
    if (token?.kind !== 'argument') return false;
    const kind = argKind(token.name);
    return kind === 'player' || kind === 'targets';
  });
}

/** Rendu texte d'un usage, pour l'aperçu. */
export function formatUsage(usage: CommandUsage): string {
  return usage
    .map((t) => {
      switch (t.kind) {
        case 'literal':
          return t.value;
        case 'alternatives':
          return t.optional === true ? `[${t.values.join('|')}]` : `(${t.values.join('|')})`;
        case 'argument': {
          const body = `<${t.name}${t.greedy === true ? '…' : ''}>`;
          return t.optional === true ? `[${body}]` : body;
        }
        case 'ellipsis':
          return '…';
      }
    })
    .join(' ');
}
