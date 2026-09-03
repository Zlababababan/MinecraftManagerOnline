/**
 * Suivi des tasks (phase 8) : ligne de progression (phase traduite, %, détail, annulation) et
 * indicateur global dans la coquille (badge + liste des tasks actives, alimentés par `task.update`).
 */
import {
  ActionIcon,
  Badge,
  Group,
  Indicator,
  Popover,
  Progress,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconActivity, IconX } from '@tabler/icons-react';

import type { TaskDto } from '@mmo/protocol/client';

import { useActiveTasks, useCancelTask } from '../../api/phase8.js';
import { useMe } from '../../api/queries.js';
import { useT } from '../../i18n/hooks.js';
import { tDynamic } from '../../i18n/index.js';
import { describeError } from '../../lib/errors.js';
import { canTask } from '../../lib/permissions.js';
import { RouterAnchor } from '../links.js';

export const ACTIVE_TASK_STATUSES: ReadonlySet<TaskDto['status']> = new Set([
  'pending',
  'running',
  'stalled',
]);

export function isActiveTask(task: TaskDto): boolean {
  return ACTIVE_TASK_STATUSES.has(task.status);
}

export function taskStatusColor(status: TaskDto['status']): string {
  switch (status) {
    case 'done':
      return 'green';
    case 'failed':
      return 'red';
    case 'cancelled':
      return 'gray';
    case 'stalled':
      return 'orange';
    case 'pending':
    case 'running':
      return 'blue';
  }
}

/** Libellé d'un genre de task (genre inconnu affiché tel quel : le protocole évolue par ajout). */
export function useTaskKindLabel(): (kind: string) => string {
  const { i18n } = useT();
  return (kind) => {
    const key = `web:tasks.kinds.${kind.replace(/\./g, '_')}`;
    return i18n.exists(key) ? tDynamic(i18n, key) : kind;
  };
}

export function useTaskPhaseLabel(): (phase: string | null) => string {
  const { i18n } = useT();
  return (phase) => {
    if (phase === null) return '';
    const key = `web:tasks.phases.${phase}`;
    return i18n.exists(key) ? tDynamic(i18n, key) : phase;
  };
}

export function TaskProgressRow({ task, compact = false }: { task: TaskDto; compact?: boolean }) {
  const { t, i18n } = useT();
  const me = useMe();
  const cancel = useCancelTask();
  const kindLabel = useTaskKindLabel();
  const phaseLabel = useTaskPhaseLabel();
  const active = isActiveTask(task);
  const canCancel = active && canTask(me.data, task, 'operator') && !cancel.isPending;
  const pct = Math.max(0, Math.min(100, task.progress ?? 0));
  return (
    <Stack gap={4} data-testid={`task-${task.id}`} data-status={task.status}>
      <Group justify="space-between" gap="xs" wrap="nowrap">
        <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
          <Text size="sm" fw={600} truncate>
            {kindLabel(task.kind)}
          </Text>
          <Badge size="xs" color={taskStatusColor(task.status)} variant="light">
            {t(`web:tasks.status.${task.status}`)}
          </Badge>
        </Group>
        <Group gap="xs" wrap="nowrap">
          {active && (
            <Text size="xs" c="dimmed">
              {phaseLabel(task.phase)}
              {task.progress === null ? '' : ` · ${String(Math.round(pct))} %`}
            </Text>
          )}
          {canCancel && (
            <Tooltip label={t('web:tasks.cancel')}>
              <ActionIcon
                size="sm"
                variant="subtle"
                color="red"
                aria-label={t('web:tasks.cancel')}
                data-testid={`task-cancel-${task.id}`}
                onClick={() => {
                  cancel.mutate(task.id, {
                    onError: (error) => {
                      notifications.show({ color: 'red', message: describeError(i18n, error) });
                    },
                  });
                }}
              >
                <IconX size={14} />
              </ActionIcon>
            </Tooltip>
          )}
        </Group>
      </Group>
      {active && (
        <Progress
          value={pct}
          aria-label={`${String(Math.round(pct))} %`}
          size={compact ? 'xs' : 'sm'}
          animated={task.status === 'running'}
          color={task.status === 'stalled' ? 'orange' : 'blue'}
        />
      )}
      {!compact && task.detail !== null && active && (
        <Text size="xs" c="dimmed" truncate>
          {task.detail}
        </Text>
      )}
      {task.status === 'failed' && task.error !== null && (
        <Text size="xs" c="red">
          {describeError(i18n, task.error)}
        </Text>
      )}
    </Stack>
  );
}

/** Badge des tasks actives (toutes machines) dans l'en-tête. */
export function TasksIndicator() {
  const { t } = useT();
  const tasks = useActiveTasks();
  const active = (tasks.data?.tasks ?? []).filter(isActiveTask);
  return (
    <Popover width={340} position="bottom-end" shadow="md" withinPortal>
      {/* Cible = le bouton (les attributs aria-haspopup/expanded ne sont pas permis sur un div). */}
      <Indicator
        disabled={active.length === 0}
        label={active.length}
        size={16}
        color="blue"
        processing
      >
        <Popover.Target>
          <ActionIcon
            variant="subtle"
            aria-label={t('web:tasks.title')}
            data-testid="tasks-indicator"
            data-count={active.length}
          >
            <IconActivity size={18} />
          </ActionIcon>
        </Popover.Target>
      </Indicator>
      <Popover.Dropdown>
        <Stack gap="sm">
          <Text size="sm" fw={600}>
            {t('web:tasks.title')}
          </Text>
          {active.length === 0 ? (
            <Text size="sm" c="dimmed">
              {t('web:tasks.none')}
            </Text>
          ) : (
            active.map((task) => (
              <Stack gap={2} key={task.id}>
                <TaskProgressRow task={task} compact />
                {task.serverId !== null && (
                  <RouterAnchor
                    size="xs"
                    to="/servers/$serverId"
                    params={{ serverId: task.serverId }}
                    search={{ tab: 'backups' }}
                  >
                    {t('web:tasks.openServer')}
                  </RouterAnchor>
                )}
              </Stack>
            ))
          )}
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
