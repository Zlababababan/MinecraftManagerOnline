/**
 * Priorité CPU du processus Java d'un serveur (remontée d'usage : « un onglet Twitch qui rame
 * quand un serveur tourne »).
 *
 * Tout passe par `os.setPriority`, donc **aucun module natif** (décision verrouillée) : libuv
 * traduit le `nice` Unix en classe de priorité Windows, et 0 / 10 / 19 font l'aller-retour exact
 * dans les deux sens (NORMAL / BELOW_NORMAL / IDLE). C'est ce qui permet de lire la priorité
 * courante avant d'écrire, et donc de ne RIEN faire — ni appel, ni ligne de journal — quand elle
 * est déjà la bonne : sans cela, chaque reconnexion d'agent rejouerait le réglage et, sur Linux,
 * avertirait à chaque fois de ne pas pouvoir le remonter.
 *
 * Limite assumée, dite ici parce qu'elle ne se voit pas à la lecture de `os.setPriority` :
 * - Windows applique la classe au PROCESSUS entier, immédiatement, y compris sur un serveur déjà
 *   en marche — c'est la plateforme d'où vient la remontée, et là le réglage est exact ;
 * - Linux compte le `nice` par THREAD. Appliqué juste après le spawn, le thread principal de la
 *   JVM est encore seul et tous ceux qu'il crée ensuite en héritent ; appliqué à un serveur qui
 *   tourne déjà (changement de réglage, ré-adoption), il ne touche que ce thread principal et ne
 *   prend vraiment effet qu'au redémarrage suivant.
 * - Unix n'autorise pas à REMONTER un `nice` sans privilège : repasser un serveur en marche de
 *   `low` à `normal` est refusé (EPERM) et n'aura lieu qu'au prochain démarrage. Ce n'est pas une
 *   panne : on le journalise et on continue.
 *
 * Rien de tout cela ne peut empêcher un serveur de démarrer : les fonctions de ce module ne
 * lèvent jamais.
 */
import os from 'node:os';

import type { CpuPriority } from '@mmo/protocol';

import type { Logger } from '../log.js';

/** Valeurs `nice` correspondantes ; ce sont les constantes `os.constants.priority`. */
export const NICE_BY_PRIORITY: Record<CpuPriority, number> = {
  normal: 0,
  below_normal: 10,
  low: 19,
};

/** Absent (agent configuré par un panel N-1, ou serveur jamais réglé) = priorité normale. */
export function niceFor(priority: CpuPriority | undefined): number {
  return NICE_BY_PRIORITY[priority ?? 'normal'];
}

export type CpuPriorityReason = 'already' | 'denied' | 'gone' | 'error';

export interface CpuPriorityOutcome {
  /** `true` seulement si la priorité a réellement changé. */
  readonly changed: boolean;
  readonly reason?: CpuPriorityReason;
  readonly from?: number;
  readonly to: number;
  readonly error?: string;
}

/** Accès à l'OS, injectable : les tests n'ont pas à renicer de vrais processus. */
export interface PriorityIo {
  getPriority(pid: number): number;
  setPriority(pid: number, priority: number): void;
}

const systemIo: PriorityIo = {
  getPriority: (pid) => os.getPriority(pid),
  setPriority: (pid, priority) => {
    os.setPriority(pid, priority);
  },
};

/**
 * `os.setPriority` échoue toujours en `ERR_SYS_ERROR` : le code utile est dans le message
 * (« uv_os_setpriority returned EACCES »). La distinction ne sert qu'au journal — le comportement
 * est le même dans tous les cas : prévenir et continuer.
 */
function classify(error: unknown): CpuPriorityReason {
  const message = error instanceof Error ? error.message : String(error);
  if (/\bE(PERM|ACCES)\b/.test(message)) return 'denied';
  if (/\bESRCH\b/.test(message)) return 'gone';
  return 'error';
}

/**
 * Applique la priorité si elle n'est pas déjà celle-là. Ne lève jamais : le résultat se lit dans
 * la valeur de retour, et l'appelant décide s'il journalise (voir `logCpuPriority`).
 */
export function applyCpuPriority(
  pid: number,
  priority: CpuPriority | undefined,
  io: PriorityIo = systemIo,
): CpuPriorityOutcome {
  const to = niceFor(priority);
  let from: number | undefined;
  try {
    from = io.getPriority(pid);
  } catch {
    // Priorité courante illisible : on tente quand même l'écriture, elle dira pourquoi.
    from = undefined;
  }
  if (from === to) return { changed: false, reason: 'already', from, to };
  try {
    io.setPriority(pid, to);
  } catch (error) {
    return {
      changed: false,
      reason: classify(error),
      ...(from === undefined ? {} : { from }),
      to,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  return { changed: true, ...(from === undefined ? {} : { from }), to };
}

/**
 * Applique et journalise : une ligne d'information quand la priorité change, un avertissement
 * quand l'OS refuse, et **rien du tout** quand elle est déjà la bonne (cas de très loin le plus
 * fréquent : chaque `agent.configure`, donc chaque reconnexion).
 */
export function applyAndLogCpuPriority(
  logger: Logger,
  serverId: string,
  pid: number,
  priority: CpuPriority | undefined,
  io: PriorityIo | undefined = systemIo,
): CpuPriorityOutcome {
  const outcome = applyCpuPriority(pid, priority, io);
  if (outcome.changed) {
    logger.info('cpu priority applied', {
      serverId,
      pid,
      priority: priority ?? 'normal',
      nice: outcome.to,
    });
  } else if (outcome.reason === 'denied') {
    logger.warn('cpu priority refused by the OS, will apply on next start', {
      serverId,
      pid,
      priority: priority ?? 'normal',
      error: outcome.error,
    });
  } else if (outcome.reason === 'error' || outcome.reason === 'gone') {
    logger.warn('cpu priority could not be set', {
      serverId,
      pid,
      priority: priority ?? 'normal',
      reason: outcome.reason,
      error: outcome.error,
    });
  }
  return outcome;
}
