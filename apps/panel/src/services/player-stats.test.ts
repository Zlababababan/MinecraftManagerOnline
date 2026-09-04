/**
 * Lot 8 — statistiques de fréquentation : la fonction pure qui transforme des lignes de
 * `player_sessions` en chiffres affichables. Les cas testés sont exactement ceux où une somme
 * naïve se trompe : session à cheval sur la fenêtre, sur minuit, encore ouverte, et les deux
 * journées de l'année qui ne font pas 24 heures.
 */
import { describe, expect, it } from 'vitest';

import { computePlayerStats, statsWindowStart, type StatsSession } from './player-stats.js';

const PARIS = 'Europe/Paris';
const HOUR = 3_600_000;
/** Mercredi 1er juillet 2026, minuit à Paris (= 30 juin 22 h UTC). */
const DAY0 = Date.UTC(2026, 5, 30, 22, 0);
const DAY = 24 * HOUR;

function session(
  name: string,
  joinedAt: number,
  leftAt: number | null,
  uuid = `uuid-${name}`,
): StatsSession {
  return { playerUuid: uuid, playerName: name, joinedAt, leftAt };
}

function stats(
  sessions: StatsSession[],
  options: { from?: number; to?: number; timeZone?: string; firstSeen?: Map<string, number> } = {},
) {
  const from = options.from ?? DAY0;
  return computePlayerStats({
    sessions,
    from,
    to: options.to ?? from + 3 * DAY,
    timeZone: options.timeZone ?? PARIS,
    firstSeen: options.firstSeen ?? new Map(sessions.map((s) => [s.playerUuid, s.joinedAt])),
    topLimit: 10,
  });
}

describe('lot 8 — statistiques de fréquentation', () => {
  it('compte les totaux, le classement et l’histogramme des heures', () => {
    const result = stats([
      // Alice : 20 h → 23 h le premier jour (3 h), puis 21 h → 22 h le deuxième (1 h).
      session('Alice', DAY0 + 20 * HOUR, DAY0 + 23 * HOUR),
      session('Alice', DAY0 + DAY + 21 * HOUR, DAY0 + DAY + 22 * HOUR),
      // Bob : une seule heure.
      session('Bob', DAY0 + 21 * HOUR, DAY0 + 22 * HOUR),
    ]);

    expect(result.totals.sessions).toBe(3);
    expect(result.totals.players).toBe(2);
    expect(result.totals.playtimeMs).toBe(5 * HOUR);
    expect(result.totals.longestSessionMs).toBe(3 * HOUR);
    expect(result.top[0]).toMatchObject({ name: 'Alice', playtimeMs: 4 * HOUR, sessions: 2 });
    expect(result.top[1]).toMatchObject({ name: 'Bob', playtimeMs: HOUR, sessions: 1 });

    // La somme des journées vaut le total, métrique par métrique.
    expect(result.days).toHaveLength(3);
    expect(result.days.reduce((n, d) => n + d.playtimeMs, 0)).toBe(result.totals.playtimeMs);
    expect(result.days.reduce((n, d) => n + d.sessions, 0)).toBe(result.totals.sessions);
    expect(result.days[0]).toMatchObject({ start: DAY0, sessions: 2, players: 2 });
    expect(result.days[2]).toMatchObject({ sessions: 0, players: 0, playtimeMs: 0 });

    // L'histogramme est en heures MURALES : 21 h a vu deux joueurs, 20 h un seul.
    expect(result.hours).toHaveLength(24);
    expect(result.hours[20]).toBe(HOUR);
    expect(result.hours[21]).toBe(3 * HOUR);
    expect(result.hours[22]).toBe(HOUR);
    expect(result.hours.reduce((a, b) => a + b, 0)).toBe(result.totals.playtimeMs);
  });

  it('une session à cheval sur minuit se partage entre les deux journées', () => {
    // 23 h → 1 h : une heure chaque jour, et surtout pas deux le premier.
    const result = stats([session('Alice', DAY0 + 23 * HOUR, DAY0 + 25 * HOUR)]);
    expect(result.days[0]?.playtimeMs).toBe(HOUR);
    expect(result.days[1]?.playtimeMs).toBe(HOUR);
    // Les deux journées ont vu la joueuse, mais la connexion n'est comptée que le jour du départ.
    expect(result.days[0]).toMatchObject({ players: 1, sessions: 1 });
    expect(result.days[1]).toMatchObject({ players: 1, sessions: 0 });
    expect(result.hours[23]).toBe(HOUR);
    expect(result.hours[0]).toBe(HOUR);
  });

  it('une session qui déborde de la fenêtre ne compte que sa part', () => {
    const result = stats([
      // Commencée 10 h avant la fenêtre, terminée 2 h après son début : 2 h comptent.
      session('Ancien', DAY0 - 10 * HOUR, DAY0 + 2 * HOUR),
      // Encore ouverte, commencée avant la fenêtre : court jusqu'à `to`, pas au-delà.
      session('Ouvert', DAY0 - HOUR, null, 'uuid-Ouvert'),
    ]);
    expect(result.totals.playtimeMs).toBe(2 * HOUR + 3 * DAY);
    // Ni l'une ni l'autre n'a COMMENCÉ dans la fenêtre : ce ne sont pas des connexions du jour.
    expect(result.totals.sessions).toBe(0);
    expect(result.days.reduce((n, d) => n + d.sessions, 0)).toBe(0);
    // Mais les deux joueurs sont bien là.
    expect(result.totals.players).toBe(2);
    expect(result.days[0]?.players).toBe(2);
  });

  it('une session encore ouverte s’arrête à maintenant, pas à la fin de la journée', () => {
    // Fenêtre d'un seul jour consultée à 14 h : la soirée n'a pas encore eu lieu.
    const to = DAY0 + 14 * HOUR;
    const result = stats([session('Alice', DAY0 + 12 * HOUR, null)], { to });
    expect(result.totals.playtimeMs).toBe(2 * HOUR);
    expect(result.days).toHaveLength(1);
    expect(result.days[0]?.playtimeMs).toBe(2 * HOUR);
    expect(result.hours[12]).toBe(HOUR);
    expect(result.hours[13]).toBe(HOUR);
    expect(result.hours[14]).toBe(0);
  });

  it('une horloge d’agent en avance ne fabrique pas du temps de jeu à venir', () => {
    // Les horodatages viennent de l'AGENT : une machine dont l'horloge avance de dix minutes
    // écrit un départ postérieur au « maintenant » du panel. Sans borne haute, ces minutes
    // seraient comptées comme jouées — et l'histogramme les rangerait dans une heure future.
    const to = DAY0 + 14 * HOUR;
    const result = stats([session('Alice', to - HOUR, to + 10 * 60_000)], { to });
    expect(result.totals.playtimeMs).toBe(HOUR);
    expect(result.days[0]?.playtimeMs).toBe(HOUR);
    expect(result.hours[14]).toBe(0);
    expect(result.top[0]?.lastSeenAt).toBe(to);
  });

  it('les bornes des heures viennent du fuseau, pas d’une addition de millisecondes', () => {
    // Lord Howe décale d'une DEMI-heure : le 4 octobre 2026, l'heure murale « 2 h » ne dure que
    // trente minutes et la journée en fait 23,5. Une grille bâtie en ajoutant 3 600 000 ms
    // resterait alignée sur les fuseaux à l'heure pleine, mais se décalerait ici — et rangerait
    // le temps de jeu dans la mauvaise heure jusqu'au bout de la journée.
    const zone = 'Australia/Lord_Howe';
    const day = statsWindowStart(Date.UTC(2026, 9, 4, 12, 0), 1, zone);
    const to = day + 23.5 * HOUR;
    const result = computePlayerStats({
      sessions: [session('Alice', day, to)],
      from: day,
      to,
      timeZone: zone,
      firstSeen: new Map([['uuid-Alice', day]]),
      topLimit: 10,
    });
    expect(result.days).toHaveLength(1);
    expect(result.days[0]?.playtimeMs).toBe(23.5 * HOUR);
    expect(result.hours[1]).toBe(HOUR);
    expect(result.hours[2]).toBe(HOUR / 2);
    expect(result.hours[3]).toBe(HOUR);
    expect(result.hours[23]).toBe(HOUR);
  });

  it('le record de joueurs simultanés ne compte pas un départ et une arrivée à la même seconde', () => {
    const t = DAY0 + 20 * HOUR;
    const result = stats([
      session('Alice', t, t + 2 * HOUR),
      // Bob part exactement quand Carla arrive : jamais trois en même temps.
      session('Bob', t, t + HOUR, 'uuid-Bob'),
      session('Carla', t + HOUR, t + 2 * HOUR, 'uuid-Carla'),
    ]);
    expect(result.totals.peakPlayers).toBe(2);
    expect(result.totals.peakAt).toBe(t);
  });

  it('la journée de 23 heures et celle de 25 heures sont comptées telles quelles', () => {
    // 29 mars 2026 : passage à l'heure d'été à Paris, la journée ne fait que 23 heures.
    const spring = statsWindowStart(Date.UTC(2026, 2, 29, 12, 0), 1, PARIS);
    const springResult = computePlayerStats({
      // Toute la journée locale, de minuit à minuit.
      sessions: [session('Alice', spring, spring + 23 * HOUR)],
      from: spring,
      to: spring + 23 * HOUR,
      timeZone: PARIS,
      firstSeen: new Map([['uuid-Alice', spring]]),
      topLimit: 10,
    });
    expect(springResult.days).toHaveLength(1);
    expect(springResult.days[0]?.playtimeMs).toBe(23 * HOUR);
    // 2 h du matin n'a pas eu lieu ce jour-là.
    expect(springResult.hours[2]).toBe(0);
    expect(springResult.hours[1]).toBe(HOUR);
    expect(springResult.hours[3]).toBe(HOUR);

    // 25 octobre 2026 : retour à l'heure d'hiver, 25 heures, et 2 h a lieu DEUX fois.
    const autumn = statsWindowStart(Date.UTC(2026, 9, 25, 12, 0), 1, PARIS);
    const autumnResult = computePlayerStats({
      sessions: [session('Alice', autumn, autumn + 25 * HOUR)],
      from: autumn,
      to: autumn + 25 * HOUR,
      timeZone: PARIS,
      firstSeen: new Map([['uuid-Alice', autumn]]),
      topLimit: 10,
    });
    expect(autumnResult.days).toHaveLength(1);
    expect(autumnResult.days[0]?.playtimeMs).toBe(25 * HOUR);
    expect(autumnResult.hours[2]).toBe(2 * HOUR);
  });

  it('« nouveau joueur » se juge sur la première visite du serveur, pas sur la fenêtre', () => {
    const result = stats(
      [
        session('Habitue', DAY0 + 20 * HOUR, DAY0 + 21 * HOUR, 'uuid-Habitue'),
        session('Nouveau', DAY0 + 20 * HOUR, DAY0 + 22 * HOUR, 'uuid-Nouveau'),
      ],
      {
        firstSeen: new Map([
          ['uuid-Habitue', DAY0 - 100 * DAY],
          ['uuid-Nouveau', DAY0 + 20 * HOUR],
        ]),
      },
    );
    expect(result.totals.newPlayers).toBe(1);
    expect(result.top.find((p) => p.name === 'Nouveau')?.isNew).toBe(true);
    expect(result.top.find((p) => p.name === 'Habitue')?.isNew).toBe(false);
    expect(result.top.find((p) => p.name === 'Habitue')?.firstSeenAt).toBe(DAY0 - 100 * DAY);
  });

  it('un joueur renommé garde le nom de sa visite la plus récente, quel que soit l’ordre des lignes', () => {
    const ancienne = session('AncienNom', DAY0 + HOUR, DAY0 + 2 * HOUR, 'uuid-1');
    const recente = session('NouveauNom', DAY0 + 2 * DAY, DAY0 + 2 * DAY + HOUR, 'uuid-1');
    // La base rend ses lignes dans l'ordre d'insertion, donc la plus ANCIENNE d'abord : c'est
    // l'ordre où se contenter du premier nom vu donnerait le mauvais.
    const chronologique = stats([ancienne, recente]);
    expect(chronologique.top[0]?.name).toBe('NouveauNom');
    expect(chronologique.top[0]?.sessions).toBe(2);
    // Et l'inverse doit donner exactement la même chose : le résultat ne dépend pas de l'ordre.
    expect(stats([recente, ancienne]).top[0]?.name).toBe('NouveauNom');
  });

  it('un UUID hors ligne n’est pas publié comme un identifiant Mojang', () => {
    const result = stats([session('Local', DAY0 + HOUR, DAY0 + 2 * HOUR, 'offline:0000-0000')]);
    expect(result.top[0]?.uuid).toBeNull();
  });

  it('sans aucune session, tout est à zéro et les journées existent quand même', () => {
    const result = stats([]);
    expect(result.totals).toMatchObject({ sessions: 0, players: 0, playtimeMs: 0, peakAt: null });
    expect(result.days).toHaveLength(3);
    expect(result.hours.every((h) => h === 0)).toBe(true);
    expect(result.top).toEqual([]);
  });

  it('la fenêtre commence à minuit local et compte le jour courant', () => {
    const now = Date.UTC(2026, 6, 15, 9, 30);
    expect(statsWindowStart(now, 1, PARIS)).toBe(Date.UTC(2026, 6, 14, 22, 0));
    // Sept jours = aujourd'hui plus les six précédents.
    expect(statsWindowStart(now, 7, PARIS)).toBe(Date.UTC(2026, 6, 8, 22, 0));
    // En UTC, minuit est minuit.
    expect(statsWindowStart(now, 1, 'UTC')).toBe(Date.UTC(2026, 6, 15, 0, 0));
  });
});
