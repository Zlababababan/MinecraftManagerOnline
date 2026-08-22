/**
 * Catalogue des clés connues de `server.properties` (doc 06 §7) : type, catégorie, valeur par
 * défaut vanilla, application à chaud. Les clés absentes du catalogue (mods) sont éditées en
 * texte brut dans la section « Autres clés ». Libellés et explications : `web:properties.keys.*`
 * (clé i18n = clé de propriété avec `.` → `_`).
 */
export type PropertyType =
  | { kind: 'boolean' }
  | { kind: 'int'; min?: number | undefined; max?: number | undefined }
  | { kind: 'enum'; values: readonly string[] }
  | { kind: 'string'; secret?: boolean; long?: boolean };

export const PROPERTY_CATEGORIES = [
  'general',
  'players',
  'world',
  'network',
  'performance',
  'rcon',
  'advanced',
] as const;
export type PropertyCategory = (typeof PROPERTY_CATEGORIES)[number];

export interface PropertySpec {
  key: string;
  category: PropertyCategory;
  type: PropertyType;
  default?: string;
  /** Pris en compte sans redémarrage (via commande envoyée par l'agent). */
  live?: boolean;
  /** Géré par MMO (auto-provisionnement RCON) : affiché mais verrouillé. */
  managed?: boolean;
}

const bool = { kind: 'boolean' } as const;
const int = (min?: number, max?: number): PropertyType => ({ kind: 'int', min, max });
const str: PropertyType = { kind: 'string' };

export const PROPERTY_SPECS: readonly PropertySpec[] = [
  // Général
  {
    key: 'motd',
    category: 'general',
    type: { kind: 'string', long: true },
    default: 'A Minecraft Server',
  },
  {
    key: 'gamemode',
    category: 'general',
    type: { kind: 'enum', values: ['survival', 'creative', 'adventure', 'spectator'] },
    default: 'survival',
  },
  { key: 'force-gamemode', category: 'general', type: bool, default: 'false' },
  {
    key: 'difficulty',
    category: 'general',
    type: { kind: 'enum', values: ['peaceful', 'easy', 'normal', 'hard'] },
    default: 'easy',
  },
  { key: 'hardcore', category: 'general', type: bool, default: 'false' },
  { key: 'pvp', category: 'general', type: bool, default: 'true' },
  { key: 'allow-flight', category: 'general', type: bool, default: 'false' },
  { key: 'enable-command-block', category: 'general', type: bool, default: 'false' },
  // Joueurs
  { key: 'max-players', category: 'players', type: int(0, 2_147_483_647), default: '20' },
  { key: 'online-mode', category: 'players', type: bool, default: 'true' },
  { key: 'white-list', category: 'players', type: bool, default: 'false', live: true },
  { key: 'enforce-whitelist', category: 'players', type: bool, default: 'false' },
  { key: 'player-idle-timeout', category: 'players', type: int(0), default: '0' },
  { key: 'op-permission-level', category: 'players', type: int(1, 4), default: '4' },
  { key: 'function-permission-level', category: 'players', type: int(1, 4), default: '2' },
  { key: 'hide-online-players', category: 'players', type: bool, default: 'false' },
  { key: 'enforce-secure-profile', category: 'players', type: bool, default: 'true' },
  { key: 'spawn-protection', category: 'players', type: int(0), default: '16' },
  // Monde
  { key: 'level-name', category: 'world', type: str, default: 'world' },
  { key: 'level-seed', category: 'world', type: str, default: '' },
  {
    key: 'level-type',
    category: 'world',
    type: {
      kind: 'enum',
      values: [
        'minecraft:normal',
        'minecraft:flat',
        'minecraft:large_biomes',
        'minecraft:amplified',
        'minecraft:single_biome_surface',
      ],
    },
    default: 'minecraft:normal',
  },
  { key: 'generate-structures', category: 'world', type: bool, default: 'true' },
  {
    key: 'generator-settings',
    category: 'world',
    type: { kind: 'string', long: true },
    default: '{}',
  },
  { key: 'allow-nether', category: 'world', type: bool, default: 'true' },
  { key: 'spawn-monsters', category: 'world', type: bool, default: 'true' },
  { key: 'spawn-animals', category: 'world', type: bool, default: 'true' },
  { key: 'spawn-npcs', category: 'world', type: bool, default: 'true' },
  { key: 'max-world-size', category: 'world', type: int(1, 29_999_984), default: '29999984' },
  { key: 'max-build-height', category: 'world', type: int(0), default: '256' },
  // Réseau
  { key: 'server-ip', category: 'network', type: str, default: '' },
  { key: 'server-port', category: 'network', type: int(1, 65535), default: '25565' },
  { key: 'enable-status', category: 'network', type: bool, default: 'true' },
  { key: 'enable-query', category: 'network', type: bool, default: 'false' },
  { key: 'query.port', category: 'network', type: int(1, 65535), default: '25565' },
  { key: 'network-compression-threshold', category: 'network', type: int(-1), default: '256' },
  { key: 'prevent-proxy-connections', category: 'network', type: bool, default: 'false' },
  { key: 'use-native-transport', category: 'network', type: bool, default: 'true' },
  { key: 'rate-limit', category: 'network', type: int(0), default: '0' },
  { key: 'accepts-transfers', category: 'network', type: bool, default: 'false' },
  // Performance
  { key: 'view-distance', category: 'performance', type: int(3, 32), default: '10' },
  { key: 'simulation-distance', category: 'performance', type: int(3, 32), default: '10' },
  { key: 'max-tick-time', category: 'performance', type: int(-1), default: '60000' },
  {
    key: 'entity-broadcast-range-percentage',
    category: 'performance',
    type: int(10, 1000),
    default: '100',
  },
  { key: 'sync-chunk-writes', category: 'performance', type: bool, default: 'true' },
  {
    key: 'max-chained-neighbor-updates',
    category: 'performance',
    type: int(-1),
    default: '1000000',
  },
  {
    key: 'region-file-compression',
    category: 'performance',
    type: { kind: 'enum', values: ['deflate', 'lz4', 'none'] },
    default: 'deflate',
  },
  { key: 'pause-when-empty-seconds', category: 'performance', type: int(-1), default: '60' },
  // RCON (géré par MMO)
  { key: 'enable-rcon', category: 'rcon', type: bool, default: 'false', managed: true },
  { key: 'rcon.port', category: 'rcon', type: int(1, 65535), default: '25575', managed: true },
  {
    key: 'rcon.password',
    category: 'rcon',
    type: { kind: 'string', secret: true },
    default: '',
    managed: true,
  },
  { key: 'broadcast-rcon-to-ops', category: 'rcon', type: bool, default: 'true' },
  // Avancé
  { key: 'resource-pack', category: 'advanced', type: str, default: '' },
  { key: 'resource-pack-sha1', category: 'advanced', type: str, default: '' },
  { key: 'resource-pack-prompt', category: 'advanced', type: str, default: '' },
  { key: 'require-resource-pack', category: 'advanced', type: bool, default: 'false' },
  { key: 'broadcast-console-to-ops', category: 'advanced', type: bool, default: 'true' },
  { key: 'enable-jmx-monitoring', category: 'advanced', type: bool, default: 'false' },
  { key: 'log-ips', category: 'advanced', type: bool, default: 'true' },
  { key: 'text-filtering-config', category: 'advanced', type: str, default: '' },
  { key: 'initial-enabled-packs', category: 'advanced', type: str, default: 'vanilla' },
  { key: 'initial-disabled-packs', category: 'advanced', type: str, default: '' },
  { key: 'bug-report-link', category: 'advanced', type: str, default: '' },
];

export const PROPERTY_BY_KEY: ReadonlyMap<string, PropertySpec> = new Map(
  PROPERTY_SPECS.map((s) => [s.key, s]),
);

/** Clé i18n d'une propriété (`rcon.port` → `rcon_port`). */
export function propertyI18nKey(key: string): string {
  return key.replace(/\./g, '_');
}

/** Valeur normalisée pour comparaison : `true`/`false` en minuscules, entiers sans zéros. */
export function normalizeValue(spec: PropertySpec | undefined, value: string): string {
  if (spec?.type.kind === 'boolean')
    return value.trim().toLowerCase() === 'true' ? 'true' : 'false';
  if (spec?.type.kind === 'int') {
    const n = Number(value.trim());
    return Number.isInteger(n) ? String(n) : value.trim();
  }
  return value;
}

/** Valide une valeur selon son type ; retourne un code d'erreur (`web:properties.errors.*`) ou `undefined`. */
export function validateValue(spec: PropertySpec, value: string): string | undefined {
  const t = spec.type;
  if (t.kind === 'int') {
    const n = Number(value.trim());
    if (value.trim() === '' || !Number.isInteger(n)) return 'integer';
    if (t.min !== undefined && n < t.min) return 'min';
    if (t.max !== undefined && n > t.max) return 'max';
  }
  if (t.kind === 'enum' && !t.values.includes(value)) return 'enum';
  return undefined;
}

/** Différence entre deux jeux de propriétés : clés modifiées (valeur) ou supprimées (`null`). */
export function diffProperties(
  original: Record<string, string>,
  edited: Record<string, string>,
): Record<string, string | null> {
  const patch: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(edited)) {
    const spec = PROPERTY_BY_KEY.get(key);
    if (
      !(key in original) ||
      normalizeValue(spec, original[key] ?? '') !== normalizeValue(spec, value)
    ) {
      patch[key] = value;
    }
  }
  for (const key of Object.keys(original)) if (!(key in edited)) patch[key] = null;
  return patch;
}

/** Regroupe les clés présentes + clés connues manquantes par catégorie, puis les clés inconnues. */
export function groupProperties(data: Record<string, string>): {
  categories: { category: PropertyCategory; specs: PropertySpec[] }[];
  unknown: string[];
} {
  const categories = PROPERTY_CATEGORIES.map((category) => ({
    category,
    specs: PROPERTY_SPECS.filter((s) => s.category === category),
  }));
  const unknown = Object.keys(data)
    .filter((k) => !PROPERTY_BY_KEY.has(k))
    .sort();
  return { categories, unknown };
}
