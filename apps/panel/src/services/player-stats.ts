/**
 * Statistiques de fréquentation et temps de jeu (lot 8, doc 02 §6). Tout sort de `player_sessions`,
 * qui accumule depuis toujours et n'était lue que comme un historique à plat.
 *
 * Trois pièges gouvernent ce fichier, et ce sont eux que les tests attaquent :
 *
 * 1. **Une session déborde de la fenêtre.** Celle qui a commencé avant hier soir et dure encore
 *    compte pour sa PART dans la fenêtre, pas pour sa durée totale ; une session encore ouverte
 *    court jusqu'à maintenant, jamais au-delà — les horodatages viennent de l'agent, dont
 *    l'horloge peut avancer sur celle du panel.
 * 2. **Une session déborde de la journée.** Jouer de 23 h à 1 h fait une heure à chaque jour, pas
 *    deux heures le premier. Le découpage se fait donc heure murale par heure murale.
 * 3. **Les journées ne font pas toutes 24 h.** Au changement d'heure il y en a une de 23 et une
 *    de 25, l'heure murale 2 h peut avoir lieu deux fois, et certains fuseaux décalent d'une
 *    demi-heure (Lord Howe : une journée de 23 h 30, et une heure murale qui n'en dure que 30).
 *    Les bornes viennent donc du fuseau, jamais d'une addition de millisecondes.
 *
 * La grille d'heures est construite UNE fois pour la fenêtre, puis chaque session la parcourt :
 * `Intl` coûte cher, et une fenêtre d'un an sur un serveur fréquenté demanderait des centaines de
 * milliers d'appels si chaque session recalculait ses propres bornes.
 */
import { startOfDayIn, utcOffsetMs, wallClockIn } from '@mmo/shared';
import type { PlayerStatsDto, PlayerStatsEntry } from '@mmo/protocol/client';

const HOUR_MS = 3_600_000;

export interface StatsSession {
  playerUuid: string;
  playerName: string;
  joinedAt: number;
  leftAt: number | null;
}

export interface PlayerStatsInput {
  /** Sessions qui touchent la fenêtre (ouvertes comprises), dans n'importe quel ordre. */
  sessions: StatsSession[];
  /** Début de fenêtre : minuit local du premier jour affiché. */
  from: number;
  /** Fin de fenêtre, exclue — en pratique « maintenant ». */
  to: number;
  timeZone: string;
  /** Première visite par joueur SUR CE SERVEUR, toutes périodes (pour « nouveaux joueurs »). */
  firstSeen: Map<string, number>;
  topLimit: number;
}

interface DayBucket {
  start: number;
  sessions: number;
  playtimeMs: number;
  players: Set<string>;
}

interface HourBucket {
  start: number;
  end: number;
  /** Heure murale (0–23) : c'est elle qui range le temps dans l'histogramme. */
  hour: number;
  day: DayBucket;
}

/**
 * Grille d'heures murales de la fenêtre. Le pas est calculé à partir du décalage EN VIGUEUR :
 * il tombe juste dans les fuseaux à demi-heure comme aux changements d'heure.
 */
function buildGrid(
  from: number,
  to: number,
  timeZone: string,
): { hours: HourBucket[]; days: DayBucket[] } {
  const hours: HourBucket[] = [];
  const days: DayBucket[] = [];
  let t = from;
  let lastDayKey = '';
  while (t < to) {
    const w = wallClockIn(t, timeZone);
    const dayKey = `${String(w.year)}-${String(w.month)}-${String(w.day)}`;
    let day = days.at(-1);
    if (day === undefined || dayKey !== lastDayKey) {
      lastDayKey = dayKey;
      day = {
        start: hours.length === 0 ? from : t,
        sessions: 0,
        playtimeMs: 0,
        players: new Set(),
      };
      days.push(day);
    }
    const offset = utcOffsetMs(t, timeZone);
    const next = (Math.floor((t + offset) / HOUR_MS) + 1) * HOUR_MS - offset;
    // Une heure murale qui recule (changement d'heure) ne doit jamais figer la boucle.
    const end = Math.min(next > t ? next : t + HOUR_MS, to);
    hours.push({ start: t, end, hour: w.hour, day });
    t = end;
  }
  return { hours, days };
}

/** Index de l'heure contenant `ts` (dichotomie) ; `0` sur une grille vide, l'appelant borne. */
function hourIndexOf(hours: HourBucket[], ts: number): number {
  let low = 0;
  let high = hours.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    const bucket = hours[mid];
    if (bucket !== undefined && bucket.start <= ts) low = mid;
    else high = mid - 1;
  }
  return Math.max(0, low);
}

interface Aggregate {
  name: string;
  /** Arrivée de la session dont on a gardé le nom : un joueur peut se renommer. */
  nameAt: number;
  uuid: string;
  playtimeMs: number;
  sessions: number;
  lastSeenAt: number;
}

export function computePlayerStats(input: PlayerStatsInput): PlayerStatsDto {
  const { from, to, timeZone, firstSeen, topLimit } = input;
  const grid = buildGrid(from, to, timeZone);
  const hours = new Array<number>(24).fill(0);
  const byPlayer = new Map<string, Aggregate>();
  const edges: { ts: number; delta: number }[] = [];
  let totalSessions = 0;
  let totalPlaytime = 0;
  let longest = 0;

  for (const session of input.sessions) {
    // Une session encore ouverte court jusqu'à MAINTENANT ; et un départ postérieur à `to` (agent
    // dont l'horloge avance) ne doit pas fabriquer du temps de jeu à venir.
    const end = Math.min(session.leftAt ?? to, to);
    const start = Math.max(session.joinedAt, from);
    if (end <= start) continue;
    const startedInWindow = session.joinedAt >= from && session.joinedAt < to;

    const player = byPlayer.get(session.playerUuid) ?? {
      name: session.playerName,
      nameAt: session.joinedAt,
      uuid: session.playerUuid,
      playtimeMs: 0,
      sessions: 0,
      lastSeenAt: 0,
    };
    // Le nom affiché est celui de la visite la plus récente : les lignes arrivent dans l'ordre
    // d'insertion, donc la plus ANCIENNE d'abord — garder la première vue afficherait l'ancien
    // pseudo d'un joueur renommé.
    if (session.joinedAt >= player.nameAt) {
      player.name = session.playerName;
      player.nameAt = session.joinedAt;
    }
    player.playtimeMs += end - start;
    player.lastSeenAt = Math.max(player.lastSeenAt, end);
    // Seules les sessions COMMENCÉES dans la fenêtre sont des connexions : la queue d'une session
    // de la veille est du temps de jeu, pas une arrivée de plus.
    if (startedInWindow) {
      player.sessions += 1;
      totalSessions += 1;
    }
    byPlayer.set(session.playerUuid, player);

    totalPlaytime += end - start;
    longest = Math.max(longest, end - start);
    edges.push({ ts: start, delta: 1 }, { ts: end, delta: -1 });

    for (let i = hourIndexOf(grid.hours, start); i < grid.hours.length; i += 1) {
      const bucket = grid.hours[i];
      if (bucket === undefined || bucket.start >= end) break;
      const slice = Math.min(bucket.end, end) - Math.max(bucket.start, start);
      if (slice <= 0) continue;
      bucket.day.playtimeMs += slice;
      bucket.day.players.add(session.playerUuid);
      hours[bucket.hour] = (hours[bucket.hour] ?? 0) + slice;
    }
    if (startedInWindow) {
      const bucket = grid.hours[hourIndexOf(grid.hours, session.joinedAt)];
      if (bucket !== undefined) bucket.day.sessions += 1;
    }
  }

  // Record de joueurs simultanés : un départ à la seconde où un autre arrive ne fait pas deux
  // joueurs en même temps — les fins passent avant les débuts.
  edges.sort((a, b) => a.ts - b.ts || a.delta - b.delta);
  let concurrent = 0;
  let peakPlayers = 0;
  let peakAt: number | null = null;
  for (const edge of edges) {
    concurrent += edge.delta;
    if (concurrent > peakPlayers) {
      peakPlayers = concurrent;
      peakAt = edge.ts;
    }
  }

  const top: PlayerStatsEntry[] = [...byPlayer.values()]
    .sort((a, b) => b.playtimeMs - a.playtimeMs || a.name.localeCompare(b.name))
    .slice(0, topLimit)
    .map((p) => {
      const first = firstSeen.get(p.uuid) ?? from;
      return {
        name: p.name,
        // Un UUID « hors ligne » est dérivé du pseudo, pas un identifiant Mojang : le publier
        // ferait croire à un compte vérifié.
        uuid: p.uuid.startsWith('offline:') ? null : p.uuid,
        playtimeMs: p.playtimeMs,
        sessions: p.sessions,
        lastSeenAt: p.lastSeenAt,
        firstSeenAt: first,
        isNew: first >= from,
      };
    });

  let newPlayers = 0;
  for (const uuid of byPlayer.keys()) {
    if ((firstSeen.get(uuid) ?? from) >= from) newPlayers += 1;
  }

  return {
    from,
    to,
    timeZone,
    totals: {
      sessions: totalSessions,
      players: byPlayer.size,
      newPlayers,
      playtimeMs: totalPlaytime,
      longestSessionMs: longest,
      peakPlayers,
      peakAt,
    },
    days: grid.days.map((d) => ({
      start: d.start,
      sessions: d.sessions,
      players: d.players.size,
      playtimeMs: d.playtimeMs,
    })),
    hours,
    top,
  };
}

/** Début de fenêtre : minuit local, `days` journées en arrière (aujourd'hui compris). */
export function statsWindowStart(now: number, days: number, timeZone: string): number {
  let start = startOfDayIn(now, timeZone);
  for (let i = 1; i < days; i += 1) {
    // Deux heures avant minuit, c'est toujours la veille — même les jours de 23 h.
    start = startOfDayIn(start - 2 * HOUR_MS, timeZone);
  }
  return start;
}
