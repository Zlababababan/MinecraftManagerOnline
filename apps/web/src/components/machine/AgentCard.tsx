/**
 * Phase 9 — agent d'une machine : version du bundle, runtime Node, dernière release publiée, bouton
 * « Mettre à jour » (admin, `agent.update` : bundle signé, exit 75, rollback automatique) et rappel
 * des derniers événements de mise à jour (appliquée / annulée).
 */
import { Badge, Button, Card, Group, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconArrowUpCircle } from '@tabler/icons-react';

import type { MachineDto } from '@mmo/protocol/client';

import { useUpdateAgent } from '../../api/phase9.js';
import { useEvents, useMe } from '../../api/queries.js';
import { useT } from '../../i18n/hooks.js';
import { describeError } from '../../lib/errors.js';
import { formatDateTime, hasRole } from '../../lib/format.js';

export function AgentCard({ machine }: { machine: MachineDto }) {
  const { t, i18n } = useT();
  const me = useMe();
  const update = useUpdateAgent(machine.id);
  const events = useEvents({ machineId: machine.id, limit: 50 });
  const isAdmin = me.data !== undefined && hasRole(me.data.user.role, 'admin');
  const updateEvents = (events.data?.events ?? [])
    .filter(
      (e) =>
        e.type === 'agent.updateApplied' ||
        e.type === 'agent.updateRolledBack' ||
        e.type === 'agent.updatePushed',
    )
    .slice(0, 3);
  return (
    <Card withBorder radius="md" padding="md" data-testid="agent-card">
      <Stack gap="sm">
        <Group justify="space-between">
          <Title order={4}>{t('web:agentUpdate.title')}</Title>
          {machine.updateAvailable === true ? (
            <Badge color="yellow" variant="light" data-testid="update-available">
              {t('web:agentUpdate.available', { version: machine.latestRelease ?? '' })}
            </Badge>
          ) : (
            <Badge color="teal" variant="light">
              {t('web:agentUpdate.upToDate')}
            </Badge>
          )}
        </Group>
        <SimpleGrid cols={{ base: 2, sm: 3 }} spacing="xs">
          <Text size="sm">
            {t('web:agentUpdate.current')} : <b>{machine.agentVersion ?? '—'}</b>
          </Text>
          <Text size="sm">
            {t('web:agentUpdate.runtime')} : <b>{machine.runtimeVersion ?? '—'}</b>
          </Text>
          <Text size="sm">
            {t('web:agentUpdate.latest')} : <b>{machine.latestRelease ?? t('web:common.none')}</b>
          </Text>
        </SimpleGrid>
        {isAdmin && (
          <Group>
            <Button
              type="button"
              size="xs"
              leftSection={<IconArrowUpCircle size={14} />}
              loading={update.isPending}
              disabled={
                !machine.connected ||
                machine.latestRelease === null ||
                machine.latestRelease === undefined
              }
              data-testid="agent-update"
              onClick={() => {
                update.mutate(undefined, {
                  onSuccess: (data) => {
                    notifications.show({
                      color: data.alreadyCurrent ? 'gray' : 'teal',
                      message: data.alreadyCurrent
                        ? t('web:agentUpdate.alreadyCurrent')
                        : t('web:agentUpdate.pushed', { version: data.version }),
                    });
                  },
                  onError: (error) => {
                    notifications.show({ color: 'red', message: describeError(i18n, error) });
                  },
                });
              }}
            >
              {t('web:agentUpdate.update')}
            </Button>
            <Text size="xs" c="dimmed">
              {t('web:agentUpdate.hint')}
            </Text>
          </Group>
        )}
        {updateEvents.length > 0 && (
          <Stack gap={2}>
            {updateEvents.map((e) => {
              const p = (e.payload ?? {}) as {
                version?: string;
                otherVersion?: string | null;
                reason?: string | null;
              };
              return (
                <Text
                  key={e.id}
                  size="xs"
                  c={e.type === 'agent.updateRolledBack' ? 'red' : 'dimmed'}
                >
                  {formatDateTime(e.ts, i18n.language)} —{' '}
                  {e.type === 'agent.updateApplied'
                    ? t('web:agentUpdate.applied', { version: p.version ?? '' })
                    : e.type === 'agent.updateRolledBack'
                      ? t('web:agentUpdate.rolledBack', {
                          version: p.version ?? '',
                          other: p.otherVersion ?? '',
                          reason: p.reason ?? '',
                        })
                      : t('web:agentUpdate.pushed', { version: p.version ?? '' })}
                </Text>
              );
            })}
          </Stack>
        )}
      </Stack>
    </Card>
  );
}
