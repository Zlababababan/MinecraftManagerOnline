/**
 * Ce que montre le tableau de bord : « qu'est-ce qui se passe maintenant ? », pas la liste de tous
 * les serveurs (elle vit sur la page Serveurs). Retour de Yassin (01/10) : avec une seule machine,
 * le tableau de bord était une copie de la page machine, les actions en moins.
 */
import type { MachineDto, ServerDto } from '@mmo/protocol/client';

/** Serveurs relançables proposés d'office : assez pour retrouver le sien, pas une liste. */
export const DASHBOARD_RECENT_MAX = 6;

export interface DashboardSections {
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
  const servers = all.filter((s) => s.provisioning !== 'archived');
  const attention = servers
    .filter((s) => s.provisioning !== 'ready' || s.runState === 'crashed')
    .sort(byName);
  const flagged = new Set(attention.map((s) => s.id));
  const active = servers.filter((s) => !flagged.has(s.id) && s.runState !== 'stopped').sort(byName);
  const recent = servers
    .filter((s) => !flagged.has(s.id) && s.runState === 'stopped')
    .sort((a, b) => lastUsedAt(b) - lastUsedAt(a) || byName(a, b))
    .slice(0, DASHBOARD_RECENT_MAX);
  return { active, attention, recent };
}

/** Machines où l'on peut créer un serveur maintenant : agent en ligne et un répertoire surveillé. */
export function creatableMachines(
  machines: readonly MachineDto[],
  canOperate: (machineId: string) => boolean,
): MachineDto[] {
  return machines.filter((m) => m.connected && m.watchedDirectories.length > 0 && canOperate(m.id));
}
