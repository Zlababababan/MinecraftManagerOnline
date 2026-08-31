/**
 * Catalogue des commandes d'un serveur, pour l'aperçu de la console.
 *
 * L'agent rend les lignes brutes de `help` ; c'est ici qu'on les analyse. Ce partage n'est pas
 * arbitraire : le parseur peut être corrigé en mettant à jour le seul panel, alors que les agents
 * du parc se mettent à jour bien plus lentement.
 *
 * Trois exigences, toutes nées de ce que la console est un endroit sensible :
 *   - **aucune trace** : la découverte passe par `peer.request` en direct, jamais par les routes
 *     de commande, qui écrivent dans `command_history` et dans l'audit. Sinon `help` réapparaîtrait
 *     dans le rappel « flèche haut » de l'utilisateur.
 *   - **aucune rafale** : un PC et un téléphone ouverts sur la même console, c'est le cas courant.
 *     Une seule requête en vol par serveur, et un cache court.
 *   - **aucune erreur visible** : un agent trop ancien, un serveur arrêté, un RCON absent sont des
 *     situations ordinaires. Elles rendent « indisponible », jamais un 500.
 */
import { isProtocolError } from '@mmo/protocol';
import { parseHelpOutput, type CommandSpec } from '@mmo/shared';

import type { AgentRegistry } from '../agents/registry.js';
import type { ServersService } from './servers.js';

export type CatalogSource = 'discovered' | 'unavailable';

export interface CommandCatalog {
  source: CatalogSource;
  commands: CommandSpec[];
  /** Des lignes ont été coupées : l'aperçu ne se prétend pas exhaustif. */
  truncated: boolean;
  capturedAt: number;
}

export interface CommandCatalogDeps {
  registry: AgentRegistry;
  servers: ServersService;
  now: () => number;
  logger: { debug(obj: unknown, msg?: string): void };
  /** Durée de vie du cache (défaut 5 min) : l'arbre ne bouge qu'au redémarrage du serveur. */
  ttlMs?: number;
}

const UNAVAILABLE = (capturedAt: number): CommandCatalog => ({
  source: 'unavailable',
  commands: [],
  truncated: false,
  capturedAt,
});

interface Entry {
  catalog: CommandCatalog;
  /** Requête en vol : les appels concurrents s'y raccrochent au lieu d'en lancer une deuxième. */
  pending?: Promise<CommandCatalog>;
}

export class CommandCatalogService {
  private readonly cache = new Map<string, Entry>();

  constructor(private readonly deps: CommandCatalogDeps) {}

  /** Vide le cache d'un serveur : au redémarrage, un modpack mis à jour n'expose plus les mêmes. */
  invalidate(serverId: string): void {
    this.cache.delete(serverId);
  }

  async get(serverId: string, name?: string): Promise<CommandCatalog> {
    const fresh = name === undefined ? this.fresh(serverId) : undefined;
    if (fresh) return fresh;
    const entry = this.cache.get(serverId);
    if (entry?.pending && name === undefined) return entry.pending;
    const pending = this.load(serverId, name).finally(() => {
      const current = this.cache.get(serverId);
      if (current?.pending) delete current.pending;
    });
    if (name === undefined) {
      this.cache.set(serverId, {
        ...(entry ?? { catalog: UNAVAILABLE(this.deps.now()) }),
        pending,
      });
    }
    return pending;
  }

  private fresh(serverId: string): CommandCatalog | undefined {
    const entry = this.cache.get(serverId);
    if (!entry || entry.catalog.source === 'unavailable') return undefined;
    const ttl = this.deps.ttlMs ?? 5 * 60_000;
    return this.deps.now() - entry.catalog.capturedAt < ttl ? entry.catalog : undefined;
  }

  private async load(serverId: string, name?: string): Promise<CommandCatalog> {
    const capturedAt = this.deps.now();
    const row = this.deps.servers.get(serverId);
    if (!row) return UNAVAILABLE(capturedAt);
    try {
      const session = this.deps.registry.require(row.machineId);
      const res = await session.peer.request('server.commandHelp', {
        serverId,
        ...(name === undefined ? {} : { name }),
      });
      if (!res.available) return UNAVAILABLE(capturedAt);
      const parsed = parseHelpOutput(res.lines.join('\n'));
      // « Disponible » mais rien d'exploitable (réponse vide, help moddé non parsable) : pour
      // l'aperçu c'est équivalent à indisponible. Dire « découvert » avec zéro commande
      // masquerait la pastille « liste générique » alors que la complétion s'y rabat justement.
      if (name === undefined && parsed.specs.length === 0) return UNAVAILABLE(capturedAt);
      const catalog: CommandCatalog = {
        source: 'discovered',
        commands: parsed.specs,
        truncated: res.truncated || parsed.truncated,
        capturedAt,
      };
      if (name === undefined) this.cache.set(serverId, { catalog });
      else this.merge(serverId, parsed.specs, capturedAt);
      return name === undefined ? catalog : (this.cache.get(serverId)?.catalog ?? catalog);
    } catch (error) {
      // Machine hors ligne, agent N-1 qui ne connaît pas la requête, serveur arrêté : tous
      // ordinaires. L'interface se rabat sur son catalogue statique sans afficher d'erreur.
      this.deps.logger.debug(
        { serverId, code: isProtocolError(error) ? error.code : 'unknown' },
        'command catalog unavailable',
      );
      return UNAVAILABLE(capturedAt);
    }
  }

  /** Dépliage d'une commande : ses usages remplacent ceux déjà connus pour ce nom. */
  private merge(serverId: string, commands: CommandSpec[], capturedAt: number): void {
    const entry = this.cache.get(serverId);
    if (entry?.catalog.source !== 'discovered') return;
    const byName = new Map(entry.catalog.commands.map((c) => [c.name, c]));
    for (const spec of commands) byName.set(spec.name, spec);
    this.cache.set(serverId, {
      catalog: {
        ...entry.catalog,
        commands: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
        // Le dépliage ne rafraîchit pas la date de capture : le balayage racine reste la
        // référence de fraîcheur, sinon un dépliage prolongerait indéfiniment un cache périmé.
        capturedAt: entry.catalog.capturedAt || capturedAt,
      },
    });
  }
}
