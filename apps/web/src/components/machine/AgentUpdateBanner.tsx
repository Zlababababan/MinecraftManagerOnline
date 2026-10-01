/**
 * « Une mise à jour de l'agent est disponible » — dit sur le tableau de bord, avec le bouton
 * (retour du 02/10 : pas de détour). Avant, seule la page de la machine le montrait, et avec une
 * seule machine cette page est rangée dans Réglages : personne n'allait y voir.
 */
import { Alert, Button, Group, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconArrowUpCircle } from '@tabler/icons-react';

import type { MachineDto } from '@mmo/protocol/client';

import { useUpdateAgent } from '../../api/phase9.js';
import { useMachines, useMe } from '../../api/queries.js';
import { useT } from '../../i18n/hooks.js';
import { describeError } from '../../lib/errors.js';
import { hasRole } from '../../lib/format.js';

function Row({ machine }: { machine: MachineDto }) {
  const { t, i18n } = useT();
  const update = useUpdateAgent(machine.id);
  return (
    <Group justify="space-between" wrap="wrap" data-testid={`agent-update-${machine.id}`}>
      <Text size="sm">
        {t('web:agentUpdate.banner', {
          name: machine.name,
          current: machine.agentVersion ?? '?',
          version: machine.latestRelease ?? '',
        })}
      </Text>
      <Button
        size="xs"
        leftSection={<IconArrowUpCircle size={14} />}
        loading={update.isPending}
        data-testid={`agent-update-run-${machine.id}`}
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
    </Group>
  );
}

export function AgentUpdateBanner() {
  const { t } = useT();
  const me = useMe();
  const machines = useMachines();
  const isAdmin = me.data !== undefined && hasRole(me.data.user.role, 'admin');
  // Hors ligne, on ne peut rien pousser : la bannière ne proposerait qu'un bouton mort.
  const outdated = (machines.data?.machines ?? []).filter(
    (m) => m.updateAvailable === true && m.connected,
  );
  if (!isAdmin || outdated.length === 0) return null;
  return (
    <Alert color="blue" variant="light" data-testid="agent-update-banner">
      {outdated.map((m) => (
        <Row key={m.id} machine={m} />
      ))}
      <Text size="xs" c="dimmed" mt={4}>
        {t('web:agentUpdate.bannerHint')}
      </Text>
    </Alert>
  );
}
