/**
 * Saisie d'un échéancier (Planificateur v2) : fréquences en français simple — tous les jours,
 * certains jours de la semaine, toutes les N heures, une seule fois — avec sélecteurs d'heure
 * natifs et plusieurs horaires par jour. L'expression cron n'apparaît que dans le mode « Avancé »
 * (une expression à 5 champs par ligne). La prochaine exécution est affichée en évidence (heure
 * locale du navigateur — indicative : le panel évalue en heure locale de sa machine).
 * Composant contrôlé : les champs sont **dérivés** de `value` à chaque rendu (pas d'état parallèle).
 */
import {
  ActionIcon,
  Button,
  Chip,
  Group,
  NumberInput,
  Select,
  Stack,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core';
import { IconClockHour4, IconPlus, IconX } from '@tabler/icons-react';
import { useState } from 'react';

import { CRON_LIST_MAX, isValidCronList, nextCronRunList, splitCronList } from '@mmo/shared';

import { useMe } from '../../api/queries.js';
import { useT } from '../../i18n/hooks.js';
import { formatDateTime } from '../../lib/format.js';
import { ScheduleTimeZoneHint } from '../ScheduleTimeZoneHint.js';

/** Échéancier : récurrent (`cron`, 1 à 10 expressions, une par ligne) OU unique (`runAt`). */
export interface ScheduleValue {
  cron: string | null;
  runAt: number | null;
}

export type SchedulePreset = 'daily' | 'weekdays' | 'hourly' | 'once' | 'advanced';

/** Jours en ordre cron (0 = dimanche) et en ordre d'affichage (semaine française). */
export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
const UI_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

export interface ScheduleFields {
  /** Horaires `HH:MM` (quotidien / jours de la semaine), dans l'ordre de saisie. */
  times: string[];
  /** Jours cochés (noms cron), pour le préréglage `weekdays`. */
  days: string[];
  everyHours: number;
  minute: number;
  onceDate: string;
  onceTime: string;
  custom: string;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

function defaultOnce(now: number): { onceDate: string; onceTime: string } {
  const d = new Date(now + 3_600_000);
  return {
    onceDate: `${String(d.getFullYear())}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`,
    onceTime: `${pad2(d.getHours())}:00`,
  };
}

/** `HH:MM` → `[heure, minute]`, ou `undefined` si incomplet. */
function parseTime(time: string): [number, number] | undefined {
  const m = /^(\d{2}):(\d{2})$/.exec(time);
  if (!m) return undefined;
  return [Number(m[1]), Number(m[2])];
}

/** Construit la liste d'expressions d'horaires quotidiens (`days` vide ou `null` = tous les jours). */
export function buildTimesCron(times: string[], days: string[] | null): string {
  const dow = days === null ? '*' : UI_DAYS.filter((d) => days.includes(d)).join(',') || undefined;
  if (dow === undefined) return '';
  return times
    .map(parseTime)
    .filter((t): t is [number, number] => t !== undefined)
    .map(([h, m]) => `${String(m)} ${String(h)} * * ${dow}`)
    .join('\n');
}

/** Construit `runAt` (epoch ms, heure locale) depuis les champs date + heure natifs. */
export function buildOnceRunAt(onceDate: string, onceTime: string): number | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(onceDate);
  const t = parseTime(onceTime);
  if (!d || !t) return null;
  return new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3]), t[0], t[1]).getTime();
}

const SIMPLE_LINE = /^(\d{1,2}) (\d{1,2}) \* \* (\S+)$/;
const HOURLY_LINE = /^(\d{1,2}) (?:\*|\*\/(\d{1,2})) \* \* \*$/;

/** Normalise un champ jour-de-semaine simple (`mon,fri`, `1,5`) en noms cron ; `undefined` sinon. */
function parseDays(token: string): string[] | null | undefined {
  if (token === '*') return null;
  const days: string[] = [];
  for (const part of token.toLowerCase().split(',')) {
    const byName = (WEEKDAYS as readonly string[]).includes(part) ? part : undefined;
    const byNum = /^[0-7]$/.test(part) ? WEEKDAYS[Number(part) % 7] : undefined;
    const day = byName ?? byNum;
    if (day === undefined) return undefined;
    if (!days.includes(day)) days.push(day);
  }
  return days;
}

/** Devine le préréglage d'un échéancier existant (édition) et ses champs. */
export function detectSchedule(value: ScheduleValue): { preset: SchedulePreset } & ScheduleFields {
  const base: ScheduleFields = {
    times: ['04:00'],
    days: ['sun'],
    everyHours: 1,
    minute: 0,
    ...defaultOnce(Date.now()),
    custom: value.cron ?? '',
  };
  if (value.runAt !== null) {
    const d = new Date(value.runAt);
    return {
      ...base,
      preset: 'once',
      onceDate: `${String(d.getFullYear())}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`,
      onceTime: `${pad2(d.getHours())}:${pad2(d.getMinutes())}`,
    };
  }
  const lines = splitCronList(value.cron ?? '');
  if (lines.length === 0) return { ...base, preset: 'daily' };
  const parsed: { time: string; days: string[] | null }[] = [];
  for (const line of lines) {
    const m = SIMPLE_LINE.exec(line);
    if (!m) break;
    const days = parseDays(m[3] ?? '*');
    if (days === undefined) break;
    parsed.push({ time: `${pad2(Number(m[2]))}:${pad2(Number(m[1]))}`, days });
  }
  if (parsed.length === lines.length && parsed.length > 0) {
    const key = (days: string[] | null): string =>
      days === null ? '*' : UI_DAYS.filter((d) => days.includes(d)).join(',');
    const first = parsed[0]?.days ?? null;
    if (parsed.every((s) => key(s.days) === key(first))) {
      const times = parsed.map((s) => s.time);
      if (first === null) return { ...base, preset: 'daily', times };
      return { ...base, preset: 'weekdays', times, days: first };
    }
  }
  if (lines.length === 1) {
    const h = HOURLY_LINE.exec(lines[0] ?? '');
    if (h) {
      return {
        ...base,
        preset: 'hourly',
        minute: Number(h[1]),
        everyHours: h[2] === undefined ? 1 : Number(h[2]),
      };
    }
  }
  return { ...base, preset: 'advanced' };
}

/** État d'un échéancier : valide (avec sa prochaine occurrence), passé (unique), ou invalide. */
export function scheduleStatus(
  value: ScheduleValue,
  now: number,
  timeZone?: string,
): { kind: 'ok'; next: number } | { kind: 'past' } | { kind: 'invalid' } {
  if (value.runAt !== null) {
    return value.runAt > now ? { kind: 'ok', next: value.runAt } : { kind: 'past' };
  }
  if (value.cron === null || !isValidCronList(value.cron)) return { kind: 'invalid' };
  // Le fuseau du PANEL : l'aperçu doit annoncer l'instant qui se produira réellement, pas celui
  // que le navigateur aurait calculé chez lui.
  const next = nextCronRunList(value.cron, now, timeZone);
  return next === undefined ? { kind: 'invalid' } : { kind: 'ok', next };
}

export function isScheduleValid(value: ScheduleValue, now = Date.now()): boolean {
  return scheduleStatus(value, now).kind === 'ok';
}

type TFn = (key: string, opts?: Record<string, unknown>) => string;

/** Joint une liste en français simple : `a`, `a et b`, `a, b et c`. */
function joinList(items: string[], andWord: string): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')}${andWord}${items[items.length - 1] ?? ''}`;
}

/** Description en langage simple d'un échéancier (liste des planifications). */
export function describeWhen(
  cron: string | null,
  runAt: number | null,
  t: TFn,
  lang: string,
): string {
  const d = detectSchedule({ cron, runAt });
  const and = t('web:schedule.listAnd');
  const times = joinList([...d.times].sort(), and);
  switch (d.preset) {
    case 'once':
      return t('web:schedule.describe.once', { date: formatDateTime(runAt ?? 0, lang) });
    case 'daily':
      return t('web:schedule.describe.daily', { times });
    case 'weekdays':
      return t('web:schedule.describe.days', {
        days: joinList(
          UI_DAYS.filter((day) => d.days.includes(day)).map((day) =>
            t(`web:schedule.weekdays.${day}`),
          ),
          and,
        ),
        times,
      });
    case 'hourly':
      return d.everyHours <= 1
        ? t('web:schedule.describe.hourly1', { minute: d.minute })
        : t('web:schedule.describe.hourlyN', { hours: d.everyHours, minute: d.minute });
    case 'advanced':
      return t('web:schedule.describe.cron', { expr: splitCronList(cron ?? '').join(' ; ') });
  }
}

export function ScheduleInput({
  value,
  onChange,
  allowOnce = true,
  allowMultipleTimes = true,
  testId = 'schedule',
}: {
  value: ScheduleValue;
  onChange: (value: ScheduleValue) => void;
  /** `false` (sauvegardes) : pas de « une seule fois ». */
  allowOnce?: boolean;
  /** `false` (sauvegardes, cron simple requis) : un seul horaire, pas de « + Ajouter ». */
  allowMultipleTimes?: boolean;
  testId?: string;
}) {
  const { t, i18n } = useT();
  const me = useMe();
  const detected = detectSchedule(value);
  // Le préréglage choisi est le seul état local : une même expression peut aussi être éditée en
  // mode avancé.
  const [preset, setPreset] = useState<SchedulePreset>(detected.preset);
  const fields = detected;

  const emit = (next: Partial<ScheduleFields>, p: SchedulePreset = preset) => {
    const f = { ...fields, ...next };
    switch (p) {
      case 'daily':
        onChange({ cron: buildTimesCron(f.times, null), runAt: null });
        break;
      case 'weekdays':
        onChange({ cron: buildTimesCron(f.times, f.days), runAt: null });
        break;
      case 'hourly':
        onChange({
          cron:
            f.everyHours <= 1
              ? `${String(f.minute)} * * * *`
              : `${String(f.minute)} */${String(Math.max(1, Math.min(23, f.everyHours)))} * * *`,
          runAt: null,
        });
        break;
      case 'once':
        onChange({ cron: null, runAt: buildOnceRunAt(f.onceDate, f.onceTime) });
        break;
      case 'advanced':
        onChange({ cron: f.custom, runAt: null });
        break;
    }
  };
  const num = (v: number | string, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  const setTime = (index: number, time: string) => {
    if (time === '') return; // saisie en cours : on garde l'horaire précédent
    emit({ times: fields.times.map((v, i) => (i === index ? time : v)) });
  };
  const addTime = () => {
    const last = parseTime(fields.times[fields.times.length - 1] ?? '') ?? [12, 0];
    let [h] = last;
    const m = last[1];
    let candidate = '';
    for (let i = 0; i < 24; i += 1) {
      h = (h + 1) % 24;
      candidate = `${pad2(h)}:${pad2(m)}`;
      if (!fields.times.includes(candidate)) break;
    }
    emit({ times: [...fields.times, candidate] });
  };
  const status = scheduleStatus(value, Date.now(), me.data?.scheduleTimezone);
  const withTimes = preset === 'daily' || preset === 'weekdays';

  return (
    <Stack gap="xs" data-testid={`${testId}-input`}>
      <Select
        label={t('web:schedule.frequency')}
        data={(
          [
            'daily',
            'weekdays',
            'hourly',
            ...(allowOnce ? ['once' as const] : []),
            'advanced',
          ] as const
        ).map((p) => ({ value: p, label: t(`web:schedule.presets.${p}`) }))}
        value={preset}
        allowDeselect={false}
        onChange={(v) => {
          const p = (v ?? 'daily') as SchedulePreset;
          setPreset(p);
          emit({}, p);
        }}
        data-testid={`${testId}-preset`}
      />
      {preset === 'weekdays' && (
        <Stack gap={4}>
          <Text size="sm" fw={500}>
            {t('web:schedule.days')}
          </Text>
          <Chip.Group
            multiple
            value={fields.days}
            onChange={(days) => {
              // Au moins un jour : décocher le dernier laisserait un échéancier vide.
              if (days.length > 0) emit({ days });
            }}
          >
            <Group gap={6}>
              {UI_DAYS.map((day) => (
                <Chip key={day} value={day} size="xs" data-testid={`${testId}-day-${day}`}>
                  {t(`web:schedule.weekdaysShort.${day}`)}
                </Chip>
              ))}
            </Group>
          </Chip.Group>
        </Stack>
      )}
      {withTimes && (
        <Stack gap={4}>
          <Text size="sm" fw={500}>
            {t(allowMultipleTimes ? 'web:schedule.times' : 'web:schedule.time')}
          </Text>
          {fields.times.map((time, i) => (
            <Group key={i} gap="xs">
              <TextInput
                type="time"
                value={time}
                w={130}
                onChange={(e) => {
                  setTime(i, e.currentTarget.value);
                }}
                data-testid={`${testId}-time-${String(i)}`}
              />
              {fields.times.length > 1 && (
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  aria-label={t('web:schedule.removeTime')}
                  onClick={() => {
                    emit({ times: fields.times.filter((_, j) => j !== i) });
                  }}
                  data-testid={`${testId}-time-remove-${String(i)}`}
                >
                  <IconX size={14} />
                </ActionIcon>
              )}
            </Group>
          ))}
          {allowMultipleTimes && fields.times.length < CRON_LIST_MAX && (
            <Button
              type="button"
              variant="subtle"
              size="compact-xs"
              leftSection={<IconPlus size={14} />}
              style={{ alignSelf: 'flex-start' }}
              onClick={addTime}
              data-testid={`${testId}-time-add`}
            >
              {t('web:schedule.addTime')}
            </Button>
          )}
        </Stack>
      )}
      {preset === 'hourly' && (
        <Group gap="xs" grow>
          <NumberInput
            label={t('web:schedule.everyHours')}
            min={1}
            max={23}
            value={fields.everyHours}
            onChange={(v) => {
              emit({ everyHours: num(v, 1) });
            }}
          />
          <NumberInput
            label={t('web:schedule.minute')}
            min={0}
            max={59}
            value={fields.minute}
            onChange={(v) => {
              emit({ minute: num(v, 0) });
            }}
          />
        </Group>
      )}
      {preset === 'once' && (
        <Group gap="xs" grow>
          <TextInput
            type="date"
            label={t('web:schedule.onceDate')}
            value={fields.onceDate}
            onChange={(e) => {
              if (e.currentTarget.value !== '') emit({ onceDate: e.currentTarget.value });
            }}
            data-testid={`${testId}-once-date`}
          />
          <TextInput
            type="time"
            label={t('web:schedule.onceTime')}
            value={fields.onceTime}
            onChange={(e) => {
              if (e.currentTarget.value !== '') emit({ onceTime: e.currentTarget.value });
            }}
            data-testid={`${testId}-once-time`}
          />
        </Group>
      )}
      {preset === 'advanced' && (
        <Textarea
          label={t('web:schedule.cronExpression')}
          description={t('web:schedule.cronHelp')}
          autosize
          minRows={1}
          maxRows={CRON_LIST_MAX}
          value={value.cron ?? ''}
          onChange={(e) => {
            onChange({ cron: e.currentTarget.value, runAt: null });
          }}
          error={
            value.cron !== null && isValidCronList(value.cron)
              ? undefined
              : t('web:schedule.invalidCron')
          }
          data-testid={`${testId}-custom`}
        />
      )}
      <ScheduleTimeZoneHint testId={`${testId}-tz`} />
      <Group gap={6} wrap="nowrap" data-testid={`${testId}-preview`}>
        <IconClockHour4 size={16} style={{ flexShrink: 0 }} />
        {status.kind === 'ok' ? (
          <Text size="sm" fw={500}>
            {t('web:schedule.nextRunLong', {
              date: formatDateTime(status.next, i18n.language),
            })}
          </Text>
        ) : (
          <Text size="sm" c="red">
            {status.kind === 'past'
              ? t('web:schedule.oncePast')
              : t('web:schedule.invalidSchedule')}
          </Text>
        )}
      </Group>
    </Stack>
  );
}
