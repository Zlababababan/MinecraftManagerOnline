/**
 * « Je n'utilise plus Tailscale » en UN geste (retour de Yassin, 02/10). Un panel installé avec
 * Tailscale en garde trois traces, réglées dans trois écrans : le mode d'accès, l'URL publique
 * (`…ts.net`, reprise par les commandes d'installation et les liens des notifications) et l'adresse
 * donnée aux joueurs par chaque serveur. Quand le panel est réglé sur Tailscale mais consulté sans
 * passer par lui, on le dit et on propose de tout régler d'un coup — après avoir dit quoi.
 */
import { Alert, Button, Group, List, Stack, Text } from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';

import type { AccessStatusDto } from '@mmo/protocol/client';

import { useSetExposeModeAll, useUpdateSettings } from '../../api/phase10.js';
import { useT } from '../../i18n/hooks.js';
import { describeError } from '../../lib/errors.js';

export function LeaveTailscale({ status }: { status: AccessStatusDto }) {
  const { t, i18n } = useT();
  const update = useUpdateSettings();
  const exposeAll = useSetExposeModeAll();
  // Réglé sur Tailscale ET consulté par Tailscale : tout va bien, rien à proposer.
  if (status.mode !== 'tailscale' || status.requestVia === 'tailscale') return null;
  const origin = window.location.origin;

  const fail = (error: unknown): void => {
    notifications.show({ color: 'red', message: describeError(i18n, error) });
  };
  const run = (): void => {
    update.mutate(
      {
        'access.mode': 'manual',
        'panel.publicUrl': origin,
        'servers.defaultExposeMode': 'direct',
      },
      {
        onSuccess: () => {
          exposeAll.mutate('direct', {
            onSuccess: (data) => {
              notifications.show({
                color: 'teal',
                message: t('web:leaveTailscale.done', { count: data.updated }),
              });
            },
            onError: fail,
          });
        },
        onError: fail,
      },
    );
  };
  const confirm = (): void => {
    modals.openConfirmModal({
      title: t('web:leaveTailscale.button'),
      children: (
        <Stack gap="xs" data-testid="leave-tailscale-plan">
          <Text size="sm">{t('web:leaveTailscale.plan')}</Text>
          <List size="sm" spacing={4}>
            <List.Item>{t('web:leaveTailscale.stepMode')}</List.Item>
            <List.Item>{t('web:leaveTailscale.stepUrl', { url: origin })}</List.Item>
            <List.Item>{t('web:leaveTailscale.stepPlayers')}</List.Item>
          </List>
          <Text size="xs" c="dimmed">
            {t('web:leaveTailscale.note')}
          </Text>
        </Stack>
      ),
      labels: { confirm: t('web:leaveTailscale.confirm'), cancel: t('web:common.cancel') },
      onConfirm: run,
    });
  };

  return (
    <Alert color="yellow" variant="light" data-testid="leave-tailscale">
      <Group justify="space-between" wrap="wrap">
        <Text size="sm" style={{ flex: 1, minWidth: 220 }}>
          {t('web:leaveTailscale.why')}
        </Text>
        <Button
          size="xs"
          variant="light"
          loading={update.isPending || exposeAll.isPending}
          onClick={confirm}
          data-testid="leave-tailscale-button"
        >
          {t('web:leaveTailscale.button')}
        </Button>
      </Group>
    </Alert>
  );
}
