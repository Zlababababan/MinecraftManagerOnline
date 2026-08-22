/**
 * Onglet Planificateur (phase 8) : actions programmées **exécutées par le panel** — démarrage,
 * arrêt (avec avertissements aux joueurs), redémarrage, commande, annonce. Les backups planifiés
 * vivent dans l'onglet Sauvegardes (exécutés par l'agent).
 */
import {
  Badge,
  Button,
  Card,
  Group,
  Loader,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconPlus } from '@tabler/icons-react';
import { useState } from 'react';

import type {
  ScheduledAction,
  ScheduledTaskDto,
  ScheduledTaskInput,
  ServerDto,
} from '@mmo/protocol/client';

import { useScheduleMutations, useSchedules } from '../../api/phase8.js';
import { useMe } from '../../api/queries.js';
import { useT } from '../../i18n/hooks.js';
import { describeError } from '../../lib/errors.js';
import { formatDateTime, hasRole } from '../../lib/format.js';
import { ErrorAlert } from '../ErrorAlert.js';
import { CronInput } from './CronInput.js';

const ACTIONS: ScheduledAction[] = ['start', 'stop', 'restart', 'command', 'announce'];

export function describeSchedule(s: ScheduledTaskDto, t: (key: string) => string): string {
  const base = t(`web:schedule.actions.${s.action}`);
  if (s.action === 'command' && s.payload?.command !== undefined) {
    return `${base} : /${s.payload.command}`;
  }
  if (s.action === 'announce' && s.payload?.message !== undefined) {
    return `${base} : ${s.payload.message}`;
  }
  return base;
}

export function SchedulePanel({ server }: { server: ServerDto }) {
  const { t, i18n } = useT();
  const me = useMe();
  const q = useSchedules(server.id);
  const m = useScheduleMutations(server.id);
  const [editing, setEditing] = useState<ScheduledTaskDto | 'new' | undefined>(undefined);
  const canAct = me.data !== undefined && hasRole(me.data.user.role, 'operator');
  const fail = (error: unknown) => {
    notifications.show({ color: 'red', message: describeError(i18n, error) });
  };
  const schedules = q.data?.schedules ?? [];
  const tKey = (key: string): string => (i18n.t as (k: string) => string)(key);

  return (
    <Stack gap="md" data-testid="schedule-panel">
      {q.error !== null && <ErrorAlert error={q.error} />}
      <Card withBorder padding="md">
        <Group justify="space-between" mb="sm" wrap="wrap">
          <Stack gap={0}>
            <Text fw={600}>{t('web:schedule.title')}</Text>
            <Text size="xs" c="dimmed">
              {t('web:schedule.hint')}
            </Text>
          </Stack>
          {canAct && editing === undefined && (
            <Button
              type="button"
              size="xs"
              leftSection={<IconPlus size={14} />}
              onClick={() => {
                setEditing('new');
              }}
              data-testid="schedule-new"
            >
              {t('web:schedule.add')}
            </Button>
          )}
        </Group>
        {q.isPending && <Loader size="sm" />}
        {q.data !== undefined && schedules.length === 0 && editing === undefined && (
          <Text size="sm" c="dimmed" data-testid="schedule-empty">
            {t('web:schedule.empty')}
          </Text>
        )}
        <Stack gap="xs">
          {schedules.map((s) =>
            editing !== undefined && editing !== 'new' && editing.id === s.id ? (
              <ScheduleForm
                key={s.id}
                initial={s}
                onCancel={() => {
                  setEditing(undefined);
                }}
                onSubmit={(input) => {
                  m.update.mutate(
                    { scheduleId: s.id, ...input },
                    {
                      onError: fail,
                      onSuccess: () => {
                        setEditing(undefined);
                      },
                    },
                  );
                }}
              />
            ) : (
              <Group
                key={s.id}
                justify="space-between"
                wrap="wrap"
                data-testid={`schedule-${s.id}`}
              >
                <Stack gap={0} style={{ minWidth: 0 }}>
                  <Group gap="xs">
                    <Text size="sm" fw={600}>
                      {describeSchedule(s, tKey)}
                    </Text>
                    {!s.enabled && (
                      <Badge size="xs" color="gray">
                        {t('web:schedule.disabled')}
                      </Badge>
                    )}
                    {s.lastStatus !== null && s.lastStatus !== 'ok' && (
                      <Badge size="xs" color="red">
                        {s.lastStatus}
                      </Badge>
                    )}
                  </Group>
                  <Text size="xs" c="dimmed">
                    <code>{s.cron}</code>
                    {s.nextRunAt === null
                      ? ''
                      : ` · ${t('web:schedule.nextRun', { date: formatDateTime(s.nextRunAt, i18n.language) })}`}
                    {s.lastRunAt === null
                      ? ''
                      : ` · ${t('web:schedule.lastRun', { date: formatDateTime(s.lastRunAt, i18n.language) })}`}
                    {(s.payload?.warnMinutes?.length ?? 0) > 0
                      ? ` · ${t('web:schedule.warnings', { minutes: (s.payload?.warnMinutes ?? []).join(', ') })}`
                      : ''}
                  </Text>
                </Stack>
                {canAct && (
                  <Group gap="xs">
                    <Switch
                      size="sm"
                      checked={s.enabled}
                      label={t('web:schedule.enabled')}
                      onChange={(e) => {
                        m.update.mutate(
                          { scheduleId: s.id, enabled: e.currentTarget.checked },
                          { onError: fail },
                        );
                      }}
                    />
                    <Button
                      type="button"
                      size="compact-xs"
                      variant="default"
                      onClick={() => {
                        setEditing(s);
                      }}
                    >
                      {t('web:common.edit')}
                    </Button>
                    <Button
                      type="button"
                      size="compact-xs"
                      color="red"
                      variant="subtle"
                      onClick={() => {
                        m.remove.mutate(s.id, { onError: fail });
                      }}
                      data-testid={`schedule-delete-${s.id}`}
                    >
                      {t('web:common.delete')}
                    </Button>
                  </Group>
                )}
              </Group>
            ),
          )}
          {editing === 'new' && (
            <ScheduleForm
              onCancel={() => {
                setEditing(undefined);
              }}
              onSubmit={(input) => {
                m.create.mutate(input, {
                  onError: fail,
                  onSuccess: () => {
                    setEditing(undefined);
                  },
                });
              }}
            />
          )}
        </Stack>
      </Card>
    </Stack>
  );
}

function ScheduleForm({
  initial,
  onSubmit,
  onCancel,
}: {
  initial?: ScheduledTaskDto;
  onSubmit: (input: ScheduledTaskInput) => void;
  onCancel: () => void;
}) {
  const { t } = useT();
  const [action, setAction] = useState<ScheduledAction>(initial?.action ?? 'restart');
  const [cron, setCron] = useState(initial?.cron ?? '0 4 * * *');
  const [command, setCommand] = useState(initial?.payload?.command ?? '');
  const [message, setMessage] = useState(initial?.payload?.message ?? '');
  const [warn, setWarn] = useState((initial?.payload?.warnMinutes ?? [5, 1]).join(', '));
  const needsWarnings = action === 'stop' || action === 'restart';
  const submit = () => {
    const warnMinutes = warn
      .split(/[,\s]+/)
      .map((s) => Number(s))
      .filter((n) => Number.isInteger(n) && n > 0);
    const payload: NonNullable<ScheduledTaskInput['payload']> = {
      ...(action === 'command' ? { command } : {}),
      ...(message !== '' ? { message } : {}),
      ...(needsWarnings && warnMinutes.length > 0 ? { warnMinutes } : {}),
    };
    onSubmit({ action, cron, payload });
  };
  return (
    <Card withBorder padding="sm" data-testid="schedule-form">
      <Stack gap="sm">
        <Select
          label={t('web:schedule.action')}
          data={ACTIONS.map((a) => ({ value: a, label: t(`web:schedule.actions.${a}`) }))}
          value={action}
          allowDeselect={false}
          onChange={(v) => {
            setAction((v ?? 'restart') as ScheduledAction);
          }}
          data-testid="schedule-action"
        />
        <CronInput value={cron} onChange={setCron} testId="schedule-cron" />
        {action === 'command' && (
          <TextInput
            label={t('web:schedule.command')}
            placeholder="say Bonjour"
            value={command}
            onChange={(e) => {
              setCommand(e.currentTarget.value);
            }}
            data-testid="schedule-command"
          />
        )}
        {(action === 'announce' || needsWarnings) && (
          <TextInput
            label={t('web:schedule.message')}
            description={needsWarnings ? t('web:schedule.messageHint') : undefined}
            placeholder={needsWarnings ? t('web:schedule.messagePlaceholder') : ''}
            value={message}
            onChange={(e) => {
              setMessage(e.currentTarget.value);
            }}
            data-testid="schedule-message"
          />
        )}
        {needsWarnings && (
          <TextInput
            label={t('web:schedule.warnMinutes')}
            description={t('web:schedule.warnMinutesHint')}
            value={warn}
            onChange={(e) => {
              setWarn(e.currentTarget.value);
            }}
          />
        )}
        <Group justify="flex-end" gap="xs">
          <Button type="button" variant="default" size="xs" onClick={onCancel}>
            {t('web:common.cancel')}
          </Button>
          <Button type="button" size="xs" onClick={submit} data-testid="schedule-save">
            {t('web:common.save')}
          </Button>
        </Group>
      </Stack>
    </Card>
  );
}
