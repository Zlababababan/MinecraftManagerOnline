import { describe, expect, it } from 'vitest';

import {
  CronError,
  cronMatches,
  cronNext,
  isValidCron,
  isValidCronList,
  nextCronRun,
  nextCronRunList,
  parseCron,
  splitCronList,
} from './cron.js';

const local = (y: number, m: number, d: number, h = 0, min = 0): number =>
  new Date(y, m - 1, d, h, min, 0, 0).getTime();

describe('cron — analyse', () => {
  it('accepte les formes usuelles', () => {
    expect(parseCron('0 4 * * *').hours).toEqual(new Set([4]));
    expect([...parseCron('*/15 * * * *').minutes]).toEqual([0, 15, 30, 45]);
    expect([...parseCron('0 0 1,15 * *').daysOfMonth]).toEqual([1, 15]);
    expect([...parseCron('0 0 * * mon-fri').daysOfWeek]).toEqual([1, 2, 3, 4, 5]);
    expect([...parseCron('0 0 * jan,dec *').months]).toEqual([1, 12]);
    expect([...parseCron('0 0 * * 7').daysOfWeek]).toEqual([0]);
    expect([...parseCron('5-20/5 * * * *').minutes]).toEqual([5, 10, 15, 20]);
    expect([...parseCron('30/10 * * * *').minutes]).toEqual([30, 40, 50]);
  });

  it('rejette les expressions invalides', () => {
    for (const bad of [
      '',
      '* * * *',
      '60 * * * *',
      '* 24 * * *',
      'a * * * *',
      '*/0 * * * *',
      '5-3 * * * *',
      '0 0 32 * *',
    ]) {
      expect(() => parseCron(bad), bad).toThrow(CronError);
      expect(isValidCron(bad)).toBe(false);
    }
    expect(isValidCron('0 4 * * *')).toBe(true);
  });
});

describe('cron — prochaine occurrence (heure locale)', () => {
  it('quotidien à 04:00', () => {
    const next = cronNext(parseCron('0 4 * * *'), local(2026, 8, 22, 10, 30));
    expect(next).toBe(local(2026, 8, 23, 4, 0));
    expect(cronNext(parseCron('0 4 * * *'), local(2026, 8, 22, 3, 59))).toBe(local(2026, 8, 22, 4));
    // strictement après : à 04:00 pile, la prochaine est le lendemain
    expect(cronNext(parseCron('0 4 * * *'), local(2026, 8, 22, 4, 0))).toBe(local(2026, 8, 23, 4));
  });

  it('toutes les 15 minutes', () => {
    expect(cronNext(parseCron('*/15 * * * *'), local(2026, 8, 22, 10, 31))).toBe(
      local(2026, 8, 22, 10, 45),
    );
    expect(cronNext(parseCron('*/15 * * * *'), local(2026, 8, 22, 23, 50))).toBe(
      local(2026, 8, 23, 0, 0),
    );
  });

  it('hebdomadaire (dimanche 03:00) et règle OU jour-du-mois / jour-de-semaine', () => {
    // 2026-08-22 est un samedi
    expect(new Date(local(2026, 8, 22)).getDay()).toBe(6);
    expect(cronNext(parseCron('0 3 * * sun'), local(2026, 8, 22, 12))).toBe(local(2026, 8, 23, 3));
    // 1er du mois OU lundi : le prochain lundi (24) vient avant le 1er septembre
    expect(cronNext(parseCron('0 0 1 * mon'), local(2026, 8, 22, 12))).toBe(local(2026, 8, 24));
    expect(cronNext(parseCron('0 0 1 * mon'), local(2026, 8, 31, 12))).toBe(local(2026, 9, 1));
  });

  it('mois restreints et expression sans occurrence', () => {
    expect(cronNext(parseCron('0 0 1 jan *'), local(2026, 8, 22))).toBe(local(2027, 1, 1));
    expect(cronNext(parseCron('0 0 31 feb *'), local(2026, 8, 22))).toBeUndefined();
    expect(nextCronRun('pas du cron', 0)).toBeUndefined();
  });

  it('cronMatches', () => {
    const spec = parseCron('30 6 * * 1-5');
    expect(cronMatches(spec, new Date(local(2026, 8, 24, 6, 30)))).toBe(true); // lundi
    expect(cronMatches(spec, new Date(local(2026, 8, 23, 6, 30)))).toBe(false); // dimanche
    expect(cronMatches(spec, new Date(local(2026, 8, 24, 6, 31)))).toBe(false);
  });
});

describe('cron — listes d’expressions (une par ligne)', () => {
  it('découpe en ignorant les lignes vides et les espaces', () => {
    expect(splitCronList('0 8 * * *\n\n  30 12 * * *  \n')).toEqual(['0 8 * * *', '30 12 * * *']);
    expect(splitCronList('')).toEqual([]);
  });

  it('valide chaque expression et borne la taille', () => {
    expect(isValidCronList('0 8 * * *')).toBe(true);
    expect(isValidCronList('0 8 * * *\n30 12 * * *\n0 20 * * *')).toBe(true);
    expect(isValidCronList('')).toBe(false);
    expect(isValidCronList('0 8 * * *\npas du cron')).toBe(false);
    expect(isValidCronList(Array(11).fill('0 8 * * *').join('\n'))).toBe(false);
  });

  it('prochaine occurrence = minimum des expressions', () => {
    const after = local(2026, 8, 24, 10, 0); // lundi 10h00
    expect(nextCronRunList('0 8 * * *\n30 12 * * *\n0 20 * * *', after)).toBe(
      local(2026, 8, 24, 12, 30),
    );
    expect(nextCronRunList('0 8 * * *', local(2026, 8, 24, 9, 0))).toBe(
      nextCronRun('0 8 * * *', local(2026, 8, 24, 9, 0)),
    );
    // Les expressions sans occurrence sont ignorées ; aucune occurrence → undefined.
    expect(nextCronRunList('0 0 31 feb *\n0 20 * * *', after)).toBe(local(2026, 8, 24, 20, 0));
    expect(nextCronRunList('0 0 31 feb *', after)).toBeUndefined();
    expect(nextCronRunList('', after)).toBeUndefined();
  });
});
