/** Boutons start / stop / restart / kill d'un serveur (rôle `operator`, agent joignable). */
import { Button, Group, Text, Tooltip } from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { IconPlayerPlay, IconPlayerStop, IconRefresh, IconSkull } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { useT } from '../i18n/hooks.js';

import type { ServerDto } from '@mmo/protocol/client';

import { useMe, useServerAction, type ServerAction } from '../api/queries.js';
import { describeError } from '../lib/errors.js';
import { hasRole } from '../lib/format.js';

export function ServerActions({
  server,
  size = 'xs',
  compact = false,
}: {
  server: ServerDto;
  size?: 'xs' | 'sm' | 'md';
  compact?: boolean;
}) {
  const { t, i18n } = useT();
  const me = useMe();
  const action = useServerAction(server.id);
  const canOperate = me.data !== undefined && hasRole(me.data.user.role, 'operator');
  const busy = action.isPending;
  const reachable = server.reachable && server.provisioning === 'ready';
  const state = server.runState;
  const stoppedLike = state === 'stopped' || state === 'crashed';
  const runningLike = state === 'running' || state === 'starting';

  const run = (name: ServerAction): void => {
    action.mutate(
      { action: name },
      {
        onError: (error) => {
          notifications.show({
            color: 'red',
            title: t(`web:server.actions.${name}`),
            message: describeError(i18n, error),
          });
        },
      },
    );
  };

  const confirmKill = (): void => {
    modals.openConfirmModal({
      title: t('web:server.actions.kill'),
      children: <Text size="sm">{t('web:server.killConfirm')}</Text>,
      labels: { confirm: t('web:server.actions.kill'), cancel: t('web:common.cancel') },
      confirmProps: { color: 'red' },
      onConfirm: () => {
        run('kill');
      },
    });
  };

  if (!canOperate) return null;
  const disabledReason = !server.reachable
    ? t('web:server.unreachable')
    : server.provisioning !== 'ready'
      ? t('web:server.archived')
      : undefined;

  const wrap = (node: ReactNode) =>
    disabledReason === undefined ? (
      node
    ) : (
      <Tooltip label={disabledReason} withArrow>
        <span>{node}</span>
      </Tooltip>
    );

  return (
    <Group gap="xs" wrap="nowrap" data-testid="server-actions">
      {stoppedLike &&
        wrap(
          <Button
            size={size}
            color="green"
            leftSection={<IconPlayerPlay size={16} />}
            onClick={() => {
              run('start');
            }}
            disabled={!reachable}
            loading={busy && action.variables.action === 'start'}
            data-testid="action-start"
          >
            {compact ? null : t('web:server.actions.start')}
          </Button>,
        )}
      {runningLike &&
        wrap(
          <Button
            size={size}
            color="orange"
            variant="light"
            leftSection={<IconPlayerStop size={16} />}
            onClick={() => {
              run('stop');
            }}
            disabled={!reachable}
            loading={busy && action.variables.action === 'stop'}
            data-testid="action-stop"
          >
            {compact ? null : t('web:server.actions.stop')}
          </Button>,
        )}
      {state === 'running' &&
        wrap(
          <Button
            size={size}
            variant="default"
            leftSection={<IconRefresh size={16} />}
            onClick={() => {
              run('restart');
            }}
            disabled={!reachable}
            loading={busy && action.variables.action === 'restart'}
            data-testid="action-restart"
          >
            {compact ? null : t('web:server.actions.restart')}
          </Button>,
        )}
      {(runningLike || state === 'stopping') &&
        wrap(
          <Button
            size={size}
            color="red"
            variant="subtle"
            leftSection={<IconSkull size={16} />}
            onClick={confirmKill}
            disabled={!reachable}
            loading={busy && action.variables.action === 'kill'}
            data-testid="action-kill"
          >
            {compact ? null : t('web:server.actions.kill')}
          </Button>,
        )}
    </Group>
  );
}
