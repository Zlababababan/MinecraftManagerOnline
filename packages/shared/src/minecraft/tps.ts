/**
 * TPS / MSPT — honnêtement (doc 06 §6). Parsing des réponses RCON des commandes de la chaîne de
 * fallback : `neoforge tps` → `forge tps` → `spark tps` → `tick query` (MC ≥ 1.20.3). Regex
 * volontairement souples : les formats varient entre versions, les nombres suivent parfois la
 * locale JVM (virgule), les codes couleur `§x` sont retirés.
 */
import { compareMcVersions } from './version.js';

export type TpsSource = 'neoforge' | 'forge' | 'spark' | 'tick_query';

export interface TpsReading {
  tps: number | undefined;
  mspt: number | undefined;
}

export interface TpsMethod {
  source: TpsSource;
  command: string;
}

const TPS_COMMANDS: Record<TpsSource, string> = {
  neoforge: 'neoforge tps',
  forge: 'forge tps',
  spark: 'spark tps',
  tick_query: 'tick query',
};

export function tpsCommand(source: TpsSource): string {
  return TPS_COMMANDS[source];
}

/** Retire les codes couleur Minecraft (`§a`) et normalise les nombres à virgule. */
function clean(text: string): string {
  return text.replace(/§[0-9a-fk-orx]/gi, '').replace(/\r/g, '');
}

function num(s: string | undefined): number | undefined {
  if (s === undefined) return undefined;
  const n = Number(s.replace(',', '.'));
  return Number.isFinite(n) ? n : undefined;
}

/** Tous les nombres (`12`, `3.4`, `5,6`) d'une ligne, préfixes et décorations ignorés. */
function numbers(line: string): number[] {
  return (line.match(/\d+(?:[.,]\d+)?/g) ?? [])
    .map((v) => num(v))
    .filter((v): v is number => v !== undefined);
}

/**
 * Forge / NeoForge : `Overall: Mean tick time: 12.345 ms. Mean TPS: 20.000` (Forge ≤ 1.20) ou
 * `Overall: 20.000 TPS (12.345 ms/tick)` (NeoForge, Forge récent). Sans ligne `Overall`, on prend
 * la première dimension (`Dim minecraft:overworld …`) en dernier recours.
 */
export function parseForgeTps(text: string): TpsReading | undefined {
  const cleaned = clean(text);
  const lines = cleaned.split('\n');
  const overall = lines.find((l) => /overall/i.test(l)) ?? lines.find((l) => /tps/i.test(l));
  if (overall === undefined) return undefined;
  let m = /Mean tick time:\s*([\d.,]+)\s*ms\.?\s*Mean TPS:\s*([\d.,]+)/i.exec(overall);
  if (m) {
    const mspt = num(m[1]);
    const tps = num(m[2]);
    if (tps === undefined && mspt === undefined) return undefined;
    return { tps, mspt };
  }
  m = /([\d.,]+)\s*TPS\s*\(\s*([\d.,]+)\s*ms(?:\/tick)?\s*\)/i.exec(overall);
  if (m) return { tps: num(m[1]), mspt: num(m[2]) };
  m = /TPS:?\s*([\d.,]+)/i.exec(overall);
  if (m) {
    const tps = num(m[1]);
    return tps === undefined ? undefined : { tps, mspt: undefined };
  }
  return undefined;
}

/**
 * spark : `TPS from last 5s, 10s, 1m, 5m, 15m:` puis `20.0, 20.0, 20.0, 20.0, 20.0` (avec `*`
 * devant les valeurs et codes couleur) et `Tick durations (min/med/95%ile/max ms) from last 10s, 1m:`
 * `1.2/2.3/4.5/9.8;  1.1/2.2/4.1/12.0`. On retient le TPS à 10 s et la médiane à 10 s.
 */
export function parseSparkTps(text: string): TpsReading | undefined {
  const cleaned = clean(text).replace(/\*/g, '');
  const tpsBlock = /TPS from last[^:]*:\s*([^\n]*)/i.exec(cleaned);
  if (!tpsBlock) return undefined;
  const values = numbers(tpsBlock[1] ?? '');
  if (values.length === 0) return undefined;
  const tps = values[Math.min(1, values.length - 1)];
  let mspt: number | undefined;
  const durations = /Tick durations[^:]*:\s*([^\n]*)/i.exec(cleaned);
  if (durations) {
    const parts = numbers((durations[1] ?? '').split(';')[0] ?? '');
    mspt = parts[1] ?? parts[0];
  }
  return { tps, mspt };
}

/**
 * Vanilla ≥ 1.20.3 `/tick query` : `Target tick rate: 20.0 per second.` puis
 * `Average time per tick: 2.4ms (Target: 50.0ms)`. Le TPS effectif est borné par la cible :
 * `min(target, 1000 / mspt)`.
 */
export function parseTickQuery(text: string): TpsReading | undefined {
  const cleaned = clean(text);
  const avg = /Average time per tick:?\s*([\d.,]+)\s*ms/i.exec(cleaned);
  const target = /tick rate:?\s*([\d.,]+)\s*per second/i.exec(cleaned);
  const mspt = num(avg?.[1]);
  const targetTps = num(target?.[1]) ?? 20;
  if (mspt === undefined) return undefined;
  const tps = mspt > 0 ? Math.min(targetTps, 1000 / mspt) : targetTps;
  return { tps: Math.round(tps * 100) / 100, mspt };
}

export function parseTpsResponse(source: TpsSource, text: string): TpsReading | undefined {
  if (text.trim() === '' || /Unknown (?:or incomplete )?command/i.test(text)) return undefined;
  switch (source) {
    case 'neoforge':
    case 'forge':
      return parseForgeTps(text);
    case 'spark':
      return parseSparkTps(text);
    case 'tick_query':
      return parseTickQuery(text);
  }
}

export interface TpsChainInput {
  loader: 'vanilla' | 'forge' | 'neoforge' | 'fabric' | 'velocity' | 'unknown' | undefined;
  mcVersion: string | undefined;
  /** spark détecté dans `mods/` (jar `spark-*`). */
  sparkInstalled: boolean;
}

/**
 * Chaîne de fallback ordonnée selon le loader (doc 06 §6). Vide ⇒ « TPS indisponible » affiché
 * franchement. `tick query` n'est proposé que si la version MC est connue et ≥ 1.20.3 (ou inconnue :
 * on tente, l'échec est silencieux).
 */
export function tpsChain(input: TpsChainInput): TpsMethod[] {
  const chain: TpsSource[] = [];
  switch (input.loader) {
    case 'neoforge':
      chain.push('neoforge', 'forge');
      break;
    case 'forge':
      chain.push('forge');
      break;
    case 'unknown':
    case undefined:
      chain.push('neoforge', 'forge');
      break;
    // Un proxy n'a ni ticks ni RCON : aucune méthode, « TPS indisponible » assumé.
    case 'velocity':
      return [];
    case 'vanilla':
    case 'fabric':
      break;
  }
  if (input.sparkInstalled) chain.push('spark');
  const supportsTickQuery =
    input.mcVersion === undefined || (compareMcVersions(input.mcVersion, '1.20.3') ?? -1) >= 0;
  if (supportsTickQuery) chain.push('tick_query');
  return chain.map((source) => ({ source, command: tpsCommand(source) }));
}
