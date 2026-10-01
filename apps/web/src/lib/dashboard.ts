/**
 * Ce que montre le tableau de bord : « qu'est-ce qui se passe maintenant ? », pas la liste de tous
 * les serveurs (elle vit sur la page Serveurs). Retour de Yassin (01/10) : avec une seule machine,
 * le tableau de bord était une copie de la page machine, les actions en moins.
 */
import type { MachineDto, ServerDto } from '@mmo/protocol/client';

/** Serveurs relançables proposés d'office : assez pour retrouver le sien, pas une liste. */
export const DASHBOARD_RECENT_MAX = 6;

export interface DashboardSections {
  /** Épinglés par une étoile : toujours en tête, quel que soit leur état, et nulle part ailleurs. */
  favorites: ServerDto[];
  /** Nombre de serveurs qui tournent, favoris compris (la tuile du haut). */
  runningCount: number;
  /** En marche, en train de démarrer ou de s'arrêter : ce sur quoi on agit maintenant. */
  active: ServerDto[];
  /** Ce qui demande un geste : installation en cours ou ratée, serveur planté. */
  attention: ServerDto[];
  /** Les derniers utilisés ou créés, à l'arrêt : à relancer en un clic. */
  recent: ServerDto[];
}

const byName = (a: ServerDto, b: ServerDto): number =>
  a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

/** Dernière fois qu'on a touché au serveur : démarrage, arrêt, sinon création. */
export function lastUsedAt(server: ServerDto): number {
  return Math.max(server.startedAt ?? 0, server.stoppedAt ?? 0, server.createdAt);
}

export function dashboardSections(all: readonly ServerDto[]): DashboardSections {
  // Un serveur archivé est rangé : il n'a rien à faire sur la page « maintenant ».
  const shown = all.filter((s) => s.provisioning !== 'archived');
  const favorites = shown.filter((s) => s.favorite === true).sort(byName);
  // Une carte ne se montre qu'une fois : un favori n'est pas répété dans les autres sections.
  const servers = shown.filter((s) => s.favorite !== true);
  const runningCount = shown.filter(
    (s) => s.provisioning === 'ready' && s.runState !== 'stopped' && s.runState !== 'crashed',
  ).length;
  const attention = servers
    .filter((s) => s.provisioning !== 'ready' || s.runState === 'crashed')
    .sort(byName);
  const flagged = new Set(attention.map((s) => s.id));
  const active = servers.filter((s) => !flagged.has(s.id) && s.runState !== 'stopped').sort(byName);
  const recent = servers
    .filter((s) => !flagged.has(s.id) && s.runState === 'stopped')
    .sort((a, b) => lastUsedAt(b) - lastUsedAt(a) || byName(a, b))
    .slice(0, DASHBOARD_RECENT_MAX);
  return { favorites, runningCount, active, attention, recent };
}

/** Machines où l'on peut créer un serveur maintenant : agent en ligne et un répertoire surveillé. */
export function creatableMachines(
  machines: readonly MachineDto[],
  canOperate: (machineId: string) => boolean,
): MachineDto[] {
  return machines.filter((m) => m.connected && m.watchedDirectories.length > 0 && canOperate(m.id));
}
