/**
 * Le fuseau d'une planification. Bug signalé le 30 août 2026 : « une sauvegarde de 4 h qui part
 * à 6 h ». Les tests ci-dessous fixent la seule propriété qui compte — le résultat ne dépend PLUS
 * du fuseau du processus qui calcule — et les deux jours de l'année où ça se complique.
 */
import { describe, expect, it } from 'vitest';

import { nextCronRun } from './cron.js';
import {
  describeTimeZone,
  formatUtcOffset,
  instantOfWallClock,
  isValidTimeZone,
  localTimeZone,
  sameOffset,
  utcOffsetMs,
  wallClockIn,
} from './timezone.js';

/** L'heure murale d'un instant, en `AAAA-MM-JJ HH:MM`, pour des assertions lisibles. */
function wall(ts: number | undefined, timeZone: string): string {
  if (ts === undefined) return 'aucune';
  const w = wallClockIn(ts, timeZone);
  const p = (n: number, size = 2) => String(n).padStart(size, '0');
  return `${p(w.year, 4)}-${p(w.month)}-${p(w.day)} ${p(w.hour)}:${p(w.minute)}`;
}

describe('fuseaux horaires', () => {
  it('donne l’heure murale et le décalage en vigueur, qui change deux fois l’an', () => {
    const summer = Date.UTC(2026, 6, 1, 12, 0);
    const winter = Date.UTC(2026, 0, 1, 12, 0);
    expect(utcOffsetMs(summer, 'Europe/Paris')).toBe(2 * 3_600_000);
    expect(utcOffsetMs(winter, 'Europe/Paris')).toBe(1 * 3_600_000);
    expect(utcOffsetMs(summer, 'UTC')).toBe(0);
    expect(describeTimeZone('Europe/Paris', summer)).toBe('Europe/Paris (+02:00)');
    expect(describeTimeZone('Europe/Paris', winter)).toBe('Europe/Paris (+01:00)');
    expect(formatUtcOffset(-5 * 3_600_000 - 30 * 60_000)).toBe('-05:30');
    expect(formatUtcOffset(0)).toBe('+00:00');
  });

  it('reconnaît un fuseau valide, refuse le reste', () => {
    expect(isValidTimeZone('Europe/Paris')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone('   ')).toBe(false);
    // Le fuseau du processus est toujours un nom valide : c'est la valeur par défaut partout.
    expect(isValidTimeZone(localTimeZone())).toBe(true);
  });

  it('compare deux fuseaux à un instant donné', () => {
    const summer = Date.UTC(2026, 6, 1, 12, 0);
    expect(sameOffset('Europe/Paris', 'Europe/Madrid', summer)).toBe(true);
    expect(sameOffset('Europe/Paris', 'UTC', summer)).toBe(false);
  });

  it('convertit une heure murale en instant, et signale celle qui n’existe pas', () => {
    // Heure d'été en France : dans la nuit du 29 mars 2026, 2 h devient 3 h.
    expect(
      instantOfWallClock({ year: 2026, month: 3, day: 29, hour: 2, minute: 30 }, 'Europe/Paris'),
    ).toBeUndefined();
    // Heure d'hiver : le 25 octobre 2026, 2 h 30 a lieu deux fois — la PREMIÈRE est retenue.
    const twice = instantOfWallClock(
      { year: 2026, month: 10, day: 25, hour: 2, minute: 30 },
      'Europe/Paris',
    );
    expect(twice).toBe(Date.UTC(2026, 9, 25, 0, 30));
    expect(utcOffsetMs(twice ?? 0, 'Europe/Paris')).toBe(2 * 3_600_000);
  });
});

describe('cron dans un fuseau explicite', () => {
  const juillet = Date.UTC(2026, 6, 1, 0, 0);

  it('le résultat ne dépend plus du processus qui calcule — c’est tout le bug', () => {
    // Une sauvegarde « tous les jours à 4 h » réglée par un utilisateur à Paris part bien à 4 h
    // à Paris, y compris calculée par un agent en UTC : 02:00 UTC, pas 04:00 UTC.
    const paris = nextCronRun('0 4 * * *', juillet, 'Europe/Paris');
    expect(paris).toBe(Date.UTC(2026, 6, 1, 2, 0));
    expect(wall(paris, 'Europe/Paris')).toBe('2026-07-01 04:00');

    const utc = nextCronRun('0 4 * * *', juillet, 'UTC');
    expect(utc).toBe(Date.UTC(2026, 6, 1, 4, 0));
    // Deux heures d'écart, très exactement ce que l'utilisateur a observé.
    expect((utc ?? 0) - (paris ?? 0)).toBe(2 * 3_600_000);

    // Et l'hiver, une seule heure : le décalage n'est pas une constante.
    const janvier = Date.UTC(2026, 0, 1, 0, 0);
    expect(
      (nextCronRun('0 4 * * *', janvier, 'UTC') ?? 0) -
        (nextCronRun('0 4 * * *', janvier, 'Europe/Paris') ?? 0),
    ).toBe(1 * 3_600_000);
  });

  it('saute l’heure qui n’existe pas au passage à l’heure d’été', () => {
    // 2 h 30 n'a jamais lieu le 29 mars : la planification quotidienne saute ce jour-là plutôt
    // que d'être déplacée en douce à une heure que personne n'a demandée.
    const next = nextCronRun('30 2 * * *', Date.UTC(2026, 2, 28, 12, 0), 'Europe/Paris');
    expect(wall(next, 'Europe/Paris')).toBe('2026-03-30 02:30');
  });

  it('ne se déclenche qu’une fois quand l’heure a lieu deux fois', () => {
    const next = nextCronRun('30 2 * * *', Date.UTC(2026, 9, 24, 12, 0), 'Europe/Paris');
    expect(next).toBe(Date.UTC(2026, 9, 25, 0, 30));
    // L'occurrence suivante est le lendemain, pas la seconde 2 h 30 de la même nuit.
    expect(wall(nextCronRun('30 2 * * *', next ?? 0, 'Europe/Paris'), 'Europe/Paris')).toBe(
      '2026-10-26 02:30',
    );
  });

  it('sans fuseau, se comporte comme avant : celui du processus', () => {
    expect(nextCronRun('0 4 * * *', juillet)).toBe(
      nextCronRun('0 4 * * *', juillet, localTimeZone()),
    );
  });

  it('reste strictement après l’instant donné, même à la seconde près', () => {
    const four = Date.UTC(2026, 6, 1, 4, 0);
    expect(nextCronRun('0 4 * * *', four, 'UTC')).toBe(Date.UTC(2026, 6, 2, 4, 0));
    expect(nextCronRun('0 4 * * *', four - 1, 'UTC')).toBe(four);
  });
});
