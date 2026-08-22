/** Conflits de marqueur (doc 04 §3) : copie / migration / ignorer — admin uniquement. */
import { Alert, Button, Card, Group, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useT } from '../i18n/hooks.js';

import type { ServerConflictDto } from '@mmo/protocol/client';

import { useMachines, useMe, useResolveConflict, useServers } from '../api/queries.js';
import { describeError } from '../lib/errors.js';
import { formatDateTime, hasRole } from '../lib/format.js';

export function ConflictsPanel({ conflicts }: { conflicts: ServerConflictDto[] }) {
  const { t, i18n } = useT();
  const me = useMe();
  const machines = useMachines();
  const servers = useServers();
  const resolve = useResolveConflict();
  if (conflicts.length === 0) return null;
  const isAdmin = me.data !== undefined && hasRole(me.data.user.role, 'admin');
  const machineName = (id: string): string =>
    machines.data?.machines.find((m) => m.id === id)?.name ?? id;
  const serverName = (id: string): string =>
    servers.data?.servers.find((s) => s.id === id)?.name ?? id;

  const act = (key: string, resolution: 'copy' | 'migrate' | 'ignore'): void => {
    resolve.mutate(
      { key, resolution },
      {
        onSuccess: () => {
          notifications.show({ color: 'teal', message: t('web:conflicts.resolved') });
        },
        onError: (error) => {
          notifications.show({ color: 'red', message: describeError(i18n, error) });
        },
      },
    );
  };

  return (
    <Alert
      color="orange"
      variant="light"
      icon={<IconAlertTriangle size={18} />}
      title={t('web:conflicts.title')}
      data-testid="conflicts"
    >
      <Stack gap="sm">
        <Text size="sm">{t('web:conflicts.description')}</Text>
        {conflicts.map((c) => (
          <Card key={c.key} withBorder padding="sm" radius="sm" data-testid="conflict">
            <Stack gap={4}>
              <Text fw={600} size="sm">
                {serverName(c.serverId)} — {c.detection.name}
              </Text>
              <Text size="xs" c="dimmed">
                {t('web:conflicts.known')} : {machineName(c.known.machineId)} · {c.known.path}
              </Text>
              <Text size="xs" c="dimmed">
                {t('web:conflicts.found')} : {machineName(c.found.machineId)} · {c.found.path} ·{' '}
                {formatDateTime(c.detectedAt, i18n.language)}
              </Text>
              {isAdmin && (
                <Group gap="xs" mt={4}>
                  <Button
                    size="xs"
                    variant="light"
                    onClick={() => {
                      act(c.key, 'copy');
                    }}
                    loading={resolve.isPending && resolve.variables.key === c.key}
                    data-testid="conflict-copy"
                  >
                    {t('web:conflicts.copy')}
                  </Button>
                  <Button
                    size="xs"
                    variant="light"
                    color="grape"
                    onClick={() => {
                      act(c.key, 'migrate');
                    }}
                    loading={resolve.isPending && resolve.variables.key === c.key}
                    data-testid="conflict-migrate"
                  >
                    {t('web:conflicts.migrate')}
                  </Button>
                  <Button
                    size="xs"
                    variant="subtle"
                    color="gray"
                    onClick={() => {
                      act(c.key, 'ignore');
                    }}
                    loading={resolve.isPending && resolve.variables.key === c.key}
                    data-testid="conflict-ignore"
                  >
                    {t('web:conflicts.ignore')}
                  </Button>
                </Group>
              )}
            </Stack>
          </Card>
        ))}
      </Stack>
    </Alert>
  );
}
