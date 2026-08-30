/**
 * Planificateur v2 : détection/construction des préréglages (fonctions pures), description en
 * français simple, validité, et interactions du composant — horaires multiples, jours à puces,
 * exécution unique via champs natifs date/heure. Le Select de fréquence n'est pas manipulé
 * (piège 63 : dropdown Mantine intestable sous jsdom) — chaque préréglage est testé en ouvrant le
 * composant sur une valeur qui l'implique.
 */
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '../../i18n/index.js';
import {
  ScheduleInput,
  buildOnceRunAt,
  buildTimesCron,
  describeWhen,
  detectSchedule,
  isScheduleValid,
  type ScheduleValue,
} from './ScheduleInput.js';

const t = i18n.t as (key: string, opts?: Record<string, unknown>) => string;

describe('détection et construction des préréglages', () => {
  it('quotidien, un ou plusieurs horaires', () => {
    expect(detectSchedule({ cron: '0 4 * * *', runAt: null })).toMatchObject({
      preset: 'daily',
      times: ['04:00'],
    });
    expect(
      detectSchedule({ cron: '0 8 * * *\n30 12 * * *\n0 20 * * *', runAt: null }),
    ).toMatchObject({ preset: 'daily', times: ['08:00', '12:30', '20:00'] });
    expect(buildTimesCron(['08:00', '12:30'], null)).toBe('0 8 * * *\n30 12 * * *');
  });

  it('certains jours de la semaine (noms ou chiffres), mêmes jours sur chaque ligne', () => {
    expect(detectSchedule({ cron: '15 3 * * mon', runAt: null })).toMatchObject({
      preset: 'weekdays',
      times: ['03:15'],
      days: ['mon'],
    });
    expect(detectSchedule({ cron: '15 3 * * 1', runAt: null })).toMatchObject({
      preset: 'weekdays',
      days: ['mon'],
    });
    expect(
      detectSchedule({ cron: '0 6 * * mon,fri\n30 18 * * fri,mon', runAt: null }),
    ).toMatchObject({ preset: 'weekdays', times: ['06:00', '18:30'], days: ['mon', 'fri'] });
    // Jours différents selon la ligne : non représentable en mode simple → avancé.
    expect(detectSchedule({ cron: '0 6 * * mon\n0 6 * * fri', runAt: null }).preset).toBe(
      'advanced',
    );
    expect(buildTimesCron(['06:00'], ['fri', 'mon'])).toBe('0 6 * * mon,fri');
    expect(buildTimesCron(['06:00'], [])).toBe('');
  });

  it('toutes les N heures, exécution unique, avancé', () => {
    expect(detectSchedule({ cron: '5 */6 * * *', runAt: null })).toMatchObject({
      preset: 'hourly',
      everyHours: 6,
      minute: 5,
    });
    expect(detectSchedule({ cron: '5 * * * *', runAt: null })).toMatchObject({
      preset: 'hourly',
      everyHours: 1,
    });
    expect(detectSchedule({ cron: '0 0 1 * *', runAt: null }).preset).toBe('advanced');
    const runAt = new Date(2026, 7, 26, 18, 30).getTime();
    expect(detectSchedule({ cron: null, runAt })).toMatchObject({
      preset: 'once',
      onceDate: '2026-08-26',
      onceTime: '18:30',
    });
    expect(buildOnceRunAt('2026-08-26', '18:30')).toBe(runAt);
    expect(buildOnceRunAt('', '18:30')).toBeNull();
  });
});

describe('validité et description', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('fr');
  });

  it('isScheduleValid : cron valide, invalide, runAt futur/passé', () => {
    const now = Date.now();
    expect(isScheduleValid({ cron: '0 4 * * *', runAt: null }, now)).toBe(true);
    expect(isScheduleValid({ cron: '0 8 * * *\n30 12 * * *', runAt: null }, now)).toBe(true);
    expect(isScheduleValid({ cron: 'pas du cron', runAt: null }, now)).toBe(false);
    expect(isScheduleValid({ cron: '', runAt: null }, now)).toBe(false);
    expect(isScheduleValid({ cron: null, runAt: null }, now)).toBe(false);
    expect(isScheduleValid({ cron: null, runAt: now + 60_000 }, now)).toBe(true);
    expect(isScheduleValid({ cron: null, runAt: now - 60_000 }, now)).toBe(false);
  });

  it('describeWhen : jamais d’étoiles hors mode avancé', () => {
    expect(describeWhen('0 8 * * *\n30 12 * * *\n0 20 * * *', null, t, 'fr')).toBe(
      'Tous les jours à 08:00, 12:30 et 20:00',
    );
    expect(describeWhen('0 4 * * *', null, t, 'fr')).toBe('Tous les jours à 04:00');
    expect(describeWhen('0 6 * * mon,fri', null, t, 'fr')).toBe('Lundi et Vendredi à 06:00');
    expect(describeWhen('5 */6 * * *', null, t, 'fr')).toBe('Toutes les 6 h (minute 5)');
    expect(describeWhen('5 * * * *', null, t, 'fr')).toBe('Toutes les heures (minute 5)');
    expect(describeWhen('0 0 1 * *', null, t, 'fr')).toBe('Expression cron : 0 0 1 * *');
    const runAt = new Date(2026, 7, 26, 18, 0).getTime();
    expect(describeWhen(null, runAt, t, 'fr')).toContain('Une fois, le');
  });
});

/**
 * Le composant lit le fuseau des planifications via `/api/auth/me` : sans client de requêtes il
 * ne peut pas monter. Requête neutralisée (`retry: false`, pas de réseau sous jsdom) — le fuseau
 * reste indéfini, ce qui est exactement le cas d'un panel N-1 qui ne l'expose pas.
 */
function renderInput(value: ScheduleValue, onChange: (v: ScheduleValue) => void, allow = true) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, queryFn: () => Promise.resolve({}) } },
  });
  return render(
    <MantineProvider>
      <QueryClientProvider client={client}>
        <ScheduleInput
          value={value}
          onChange={onChange}
          allowOnce={allow}
          allowMultipleTimes={allow}
        />
      </QueryClientProvider>
    </MantineProvider>,
  );
}

describe('ScheduleInput (rendu)', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('fr');
  });

  it('quotidien multi-horaires : lignes d’heure, ajout et retrait', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderInput({ cron: '0 8 * * *\n30 12 * * *', runAt: null }, onChange);
    expect(screen.getByTestId('schedule-time-0')).toHaveValue('08:00');
    expect(screen.getByTestId('schedule-time-1')).toHaveValue('12:30');
    expect(screen.getByTestId('schedule-preview')).toHaveTextContent('Prochaine exécution');

    fireEvent.change(screen.getByTestId('schedule-time-1'), { target: { value: '13:45' } });
    expect(onChange).toHaveBeenLastCalledWith({ cron: '0 8 * * *\n45 13 * * *', runAt: null });

    await user.click(screen.getByTestId('schedule-time-add'));
    expect(onChange).toHaveBeenLastCalledWith({
      cron: '0 8 * * *\n30 12 * * *\n30 13 * * *',
      runAt: null,
    });

    await user.click(screen.getByTestId('schedule-time-remove-0'));
    expect(onChange).toHaveBeenLastCalledWith({ cron: '30 12 * * *', runAt: null });
  });

  it('jours de la semaine : puces cliquables, le dernier jour ne se décoche pas', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderInput({ cron: '0 6 * * mon', runAt: null }, onChange);
    expect(screen.getByRole('checkbox', { name: 'Lun' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Ven' })).not.toBeChecked();

    await user.click(screen.getByRole('checkbox', { name: 'Ven' }));
    expect(onChange).toHaveBeenLastCalledWith({ cron: '0 6 * * mon,fri', runAt: null });

    // Décocher le seul jour coché : ignoré (il faut au moins un jour).
    onChange.mockClear();
    await user.click(screen.getByRole('checkbox', { name: 'Lun' }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('exécution unique : champs natifs date + heure, refus du passé', () => {
    const onChange = vi.fn();
    const future = new Date(Date.now() + 86_400_000);
    const runAt = new Date(
      future.getFullYear(),
      future.getMonth(),
      future.getDate(),
      18,
      0,
    ).getTime();
    renderInput({ cron: null, runAt }, onChange);
    expect(screen.getByTestId('schedule-once-time')).toHaveValue('18:00');
    expect(screen.getByTestId('schedule-preview')).toHaveTextContent('Prochaine exécution');

    fireEvent.change(screen.getByTestId('schedule-once-time'), { target: { value: '19:15' } });
    const expected = new Date(
      future.getFullYear(),
      future.getMonth(),
      future.getDate(),
      19,
      15,
    ).getTime();
    expect(onChange).toHaveBeenLastCalledWith({ cron: null, runAt: expected });
  });

  it('exécution unique passée : message « déjà passée »', () => {
    renderInput({ cron: null, runAt: Date.now() - 60_000 }, vi.fn());
    expect(screen.getByTestId('schedule-preview')).toHaveTextContent('déjà passée');
  });

  it('mode avancé : plusieurs expressions, une par ligne, validation', () => {
    const onChange = vi.fn();
    renderInput({ cron: '0 0 1 * *', runAt: null }, onChange);
    expect(screen.getByTestId('schedule-custom')).toHaveValue('0 0 1 * *');
    fireEvent.change(screen.getByTestId('schedule-custom'), {
      target: { value: '0 0 1 * *\n0 12 15 * *' },
    });
    expect(onChange).toHaveBeenLastCalledWith({ cron: '0 0 1 * *\n0 12 15 * *', runAt: null });
  });

  it('mode sauvegardes (un seul horaire) : pas de bouton d’ajout ni d’exécution unique', () => {
    renderInput({ cron: '0 4 * * *', runAt: null }, vi.fn(), false);
    expect(screen.getByTestId('schedule-time-0')).toHaveValue('04:00');
    expect(screen.queryByTestId('schedule-time-add')).not.toBeInTheDocument();
  });
});
