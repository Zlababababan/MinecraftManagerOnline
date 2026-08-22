/**
 * Saisie d'une expression cron à 5 champs (phase 8) : préréglages lisibles (quotidien à HH:MM,
 * hebdomadaire, toutes les N heures, personnalisé), aperçu de la prochaine occurrence (heure locale
 * du navigateur — indicative : le panel et l'agent évaluent en heure locale de leur machine).
 * Composant contrôlé : les champs sont **dérivés** de `value` à chaque rendu (pas d'état parallèle).
 */
import { Group, NumberInput, Select, Stack, Text, TextInput } from '@mantine/core';
import { useState } from 'react';

import { isValidCron, nextCronRun } from '@mmo/shared';

import { useT } from '../../i18n/hooks.js';
import { formatDateTime } from '../../lib/format.js';

export type CronPreset = 'daily' | 'weekly' | 'hourly' | 'custom';

export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

export interface CronFields {
  hour: number;
  minute: number;
  weekday: string;
  everyHours: number;
  custom: string;
}

export function buildCron(preset: CronPreset, opts: CronFields): string {
  switch (preset) {
    case 'daily':
      return `${String(opts.minute)} ${String(opts.hour)} * * *`;
    case 'weekly':
      return `${String(opts.minute)} ${String(opts.hour)} * * ${opts.weekday}`;
    case 'hourly':
      return opts.everyHours <= 1
        ? `${String(opts.minute)} * * * *`
        : `${String(opts.minute)} */${String(Math.max(1, Math.min(23, opts.everyHours)))} * * *`;
    case 'custom':
      return opts.custom;
  }
}

/** Devine le préréglage d'une expression existante (édition) et ses champs. */
export function detectPreset(cron: string): { preset: CronPreset } & CronFields {
  const base: CronFields = { hour: 4, minute: 0, weekday: 'sun', everyHours: 1, custom: cron };
  const m = /^(\d{1,2}) (\d{1,2}) \* \* (\*|[a-z]{3}|\d)$/i.exec(cron.trim());
  if (m) {
    const minute = Number(m[1]);
    const hour = Number(m[2]);
    const dow = (m[3] ?? '*').toLowerCase();
    if (dow === '*') return { ...base, preset: 'daily', hour, minute };
    const weekday = /^\d$/.test(dow) ? (WEEKDAYS[Number(dow) % 7] ?? 'sun') : dow;
    return { ...base, preset: 'weekly', hour, minute, weekday };
  }
  const h = /^(\d{1,2}) (?:\*|\*\/(\d{1,2})) \* \* \*$/.exec(cron.trim());
  if (h) {
    return {
      ...base,
      preset: 'hourly',
      minute: Number(h[1]),
      everyHours: h[2] === undefined ? 1 : Number(h[2]),
    };
  }
  return { ...base, preset: 'custom' };
}

export function CronInput({
  value,
  onChange,
  testId = 'cron',
}: {
  value: string;
  onChange: (cron: string) => void;
  testId?: string;
}) {
  const { t, i18n } = useT();
  const detected = detectPreset(value);
  // Le préréglage choisi est le seul état local : une expression « 0 4 * * * » peut aussi être
  // éditée en mode personnalisé.
  const [preset, setPreset] = useState<CronPreset>(detected.preset);
  const fields: CronFields = detected;

  const set = (next: Partial<CronFields>, p: CronPreset = preset) => {
    onChange(buildCron(p, { ...fields, ...next }));
  };
  const num = (v: number | string, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  const valid = isValidCron(value);
  const next = valid ? nextCronRun(value, Date.now()) : undefined;

  return (
    <Stack gap="xs" data-testid={`${testId}-input`}>
      <Select
        label={t('web:schedule.frequency')}
        data={(['daily', 'weekly', 'hourly', 'custom'] as const).map((p) => ({
          value: p,
          label: t(`web:schedule.presets.${p}`),
        }))}
        value={preset}
        allowDeselect={false}
        onChange={(v) => {
          const p = (v ?? 'daily') as CronPreset;
          setPreset(p);
          set({}, p);
        }}
        data-testid={`${testId}-preset`}
      />
      {(preset === 'daily' || preset === 'weekly') && (
        <Group gap="xs" grow>
          {preset === 'weekly' && (
            <Select
              label={t('web:schedule.weekday')}
              data={WEEKDAYS.map((d) => ({ value: d, label: t(`web:schedule.weekdays.${d}`) }))}
              value={fields.weekday}
              allowDeselect={false}
              onChange={(v) => {
                set({ weekday: v ?? 'sun' });
              }}
            />
          )}
          <NumberInput
            label={t('web:schedule.hour')}
            min={0}
            max={23}
            value={fields.hour}
            onChange={(v) => {
              set({ hour: num(v, 0) });
            }}
            data-testid={`${testId}-hour`}
          />
          <NumberInput
            label={t('web:schedule.minute')}
            min={0}
            max={59}
            value={fields.minute}
            onChange={(v) => {
              set({ minute: num(v, 0) });
            }}
            data-testid={`${testId}-minute`}
          />
        </Group>
      )}
      {preset === 'hourly' && (
        <Group gap="xs" grow>
          <NumberInput
            label={t('web:schedule.everyHours')}
            min={1}
            max={23}
            value={fields.everyHours}
            onChange={(v) => {
              set({ everyHours: num(v, 1) });
            }}
          />
          <NumberInput
            label={t('web:schedule.minute')}
            min={0}
            max={59}
            value={fields.minute}
            onChange={(v) => {
              set({ minute: num(v, 0) });
            }}
          />
        </Group>
      )}
      {preset === 'custom' && (
        <TextInput
          label={t('web:schedule.cronExpression')}
          description={t('web:schedule.cronHelp')}
          value={value}
          onChange={(e) => {
            onChange(e.currentTarget.value);
          }}
          error={valid ? undefined : t('web:schedule.invalidCron')}
          data-testid={`${testId}-custom`}
        />
      )}
      <Text size="xs" c="dimmed" data-testid={`${testId}-preview`}>
        <code>{value}</code>
        {next === undefined
          ? valid
            ? ''
            : ` — ${t('web:schedule.invalidCron')}`
          : ` — ${t('web:schedule.nextRun', { date: formatDateTime(next, i18n.language) })}`}
      </Text>
    </Stack>
  );
}
