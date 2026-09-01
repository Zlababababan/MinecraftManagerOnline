/**
 * Filtrage et tri de la liste des serveurs. Fonctions pures, séparées de la page : c'est la seule
 * partie qui mérite d'être testée sérieusement, et elle l'est sans monter de composant.
 *
 * Ce qui est triable est contraint par le DTO serveur : `tps`, `players` et la RAM **consommée**
 * n'y sont pas (ils ne transitent qu'en `metrics.sample` temps réel). Un tri « par TPS » serait
 * donc un tri sur des trous — il n'existe pas ici. `maxRamMb` est la RAM **allouée**, statique.
 */
import type { ServerDto } from '@mmo/protocol/client';

const LOADERS = ['vanilla', 'forge', 'neoforge', 'fabric', 'velocity', 'unknown'] as const;
const RUN_STATES = ['stopped', 'starting', 'running', 'stopping', 'crashed'] as const;

export const SERVER_SORTS = ['name', 'state', 'started', 'ram'] as const;
export type ServerSort = (typeof SERVER_SORTS)[number];

export type Loader = ServerDto['loader'];
export type RunState = ServerDto['runState'];

export interface ServerFilter {
  q: string;
  machineId: string | undefined;
  loader: Loader | undefined;
  mcVersion: string | undefined;
  runState: RunState | undefined;
  sort: ServerSort;
  desc: boolean;
}

export const EMPTY_FILTER: ServerFilter = {
  q: '',
  machineId: undefined,
  loader: undefined,
  mcVersion: undefined,
  runState: undefined,
  sort: 'name',
  desc: false,
};

export function isServerSort(value: unknown): value is ServerSort {
  return typeof value === 'string' && (SERVER_SORTS as readonly string[]).includes(value);
}

/** Ordre d'affichage des états : ce qui demande de l'attention d'abord. */
const STATE_ORDER: Record<string, number> = {
  crashed: 0,
  starting: 1,
  running: 2,
  stopping: 3,
  stopped: 4,
};

/** Recherche sur le nom ET le chemin : avec 53 serveurs, le dossier est souvent ce dont on se souvient. */
function matchesText(server: ServerDto, q: string): boolean {
  if (q === '') return true;
  const needle = q.toLowerCase();
  return server.name.toLowerCase().includes(needle) || server.path.toLowerCase().includes(needle);
}

export function filterServers(servers: readonly ServerDto[], f: ServerFilter): ServerDto[] {
  const kept = servers.filter(
    (s) =>
      matchesText(s, f.q.trim()) &&
      (f.machineId === undefined || s.machineId === f.machineId) &&
      (f.loader === undefined || s.loader === f.loader) &&
      (f.mcVersion === undefined || s.mcVersion === f.mcVersion) &&
      (f.runState === undefined || s.runState === f.runState),
  );
  const compare = (a: ServerDto, b: ServerDto): number => {
    switch (f.sort) {
      case 'state':
        return (STATE_ORDER[a.runState] ?? 9) - (STATE_ORDER[b.runState] ?? 9);
      case 'started':
        // Jamais démarré en dernier, quel que soit le sens : une absence n'est pas une date.
        return (b.startedAt ?? -1) - (a.startedAt ?? -1);
      case 'ram':
        return b.maxRamMb - a.maxRamMb;
      case 'name':
        return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    }
  };
  kept.sort((a, b) => {
    const primary = compare(a, b);
    // Départage stable et lisible : à égalité, l'ordre alphabétique.
    return primary !== 0
      ? f.desc
        ? -primary
        : primary
      : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });
  return kept;
}

/** Valeurs réellement présentes, pour ne proposer que des filtres qui donnent un résultat. */
export function filterOptions(servers: readonly ServerDto[]): {
  loaders: Loader[];
  mcVersions: string[];
  runStates: RunState[];
} {
  const loaders = new Set<Loader>();
  const mcVersions = new Set<string>();
  const runStates = new Set<RunState>();
  for (const s of servers) {
    loaders.add(s.loader);
    if (s.mcVersion !== null) mcVersions.add(s.mcVersion);
    runStates.add(s.runState);
  }
  return {
    loaders: [...loaders].sort(),
    // Versions Minecraft en ordre naturel décroissant : 1.21.1 avant 1.12.2.
    mcVersions: [...mcVersions].sort((a, b) => b.localeCompare(a, undefined, { numeric: true })),
    runStates: [...runStates].sort(),
  };
}

/** Ne garde dans l'URL que ce qui s'écarte du défaut : une adresse partagée reste lisible. */
export function filterToSearch(f: ServerFilter): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  if (f.q.trim() !== '') out.q = f.q.trim();
  if (f.machineId !== undefined) out.machine = f.machineId;
  if (f.loader !== undefined) out.loader = f.loader;
  if (f.mcVersion !== undefined) out.version = f.mcVersion;
  if (f.runState !== undefined) out.state = f.runState;
  if (f.sort !== 'name') out.sort = f.sort;
  if (f.desc) out.desc = true;
  return out;
}

export function searchToFilter(search: Record<string, unknown>): ServerFilter {
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v !== '' ? v : undefined;
  // Les valeurs d'URL sont vérifiées contre les vocabulaires réels : un paramètre bricolé à la
  // main ne doit pas produire un filtre qui ne correspondra jamais à rien.
  const one = <T extends string>(v: unknown, allowed: readonly T[]): T | undefined =>
    typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : undefined;
  return {
    q: str(search.q) ?? '',
    machineId: str(search.machine),
    loader: one(search.loader, LOADERS),
    mcVersion: str(search.version),
    runState: one(search.state, RUN_STATES),
    sort: isServerSort(search.sort) ? search.sort : 'name',
    desc: search.desc === true || search.desc === 'true',
  };
}
