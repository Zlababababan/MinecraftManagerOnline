/**
 * Réglages → Accès des joueurs : l'adresse que le panel AFFICHE « à donner aux amis ».
 *
 * Ce réglage ne touche à aucun serveur Minecraft — ils écoutent de la même façon dans les deux cas.
 * Il dit seulement quelle adresse montrer : celle du tailnet (amis sur Tailscale) ou l'adresse
 * directe de la machine (IPv6 ou domaine). Retour de Yassin (01/10) : il héberge en IPv6 directe,
 * et tous ses serveurs montraient une adresse Tailscale.
 */
import { Button, Card, Group, SegmentedControl, Stack, Text, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';

import { useSetExposeModeAll, useUpdateSettings } from '../../api/phase10.js';
import { useT } from '../../i18n/hooks.js';
import { describeError } from '../../lib/errors.js';

export function PlayerExposureCard({ settings }: { settings: Record<string, string> }) {
  const { t, i18n } = useT();
  const update = useUpdateSettings();
  const applyAll = useSetExposeModeAll();
  // Absent tant que jamais modifié : le défaut serveur est « tailnet ».
  const mode = settings['servers.defaultExposeMode'] === 'direct' ? 'direct' : 'tailnet';
  const onError = (error: unknown) => {
    notifications.show({ color: 'red', message: describeError(i18n, error) });
  };
  return (
    <Card withBorder radius="md" padding="md" data-testid="settings-player-exposure">
      <Stack gap="sm">
        <Title order={2} size="h4">
          {t('web:playerExposure.title')}
        </Title>
        <Text size="xs" c="dimmed">
          {t('web:playerExposure.hint')}
        </Text>
        <Group gap="sm" align="center">
          <Text size="sm">{t('web:playerExposure.default')}</Text>
          <SegmentedControl
            size="xs"
            value={mode}
            disabled={update.isPending}
            data={[
              { value: 'tailnet', label: t('web:playerAccess.tailnet') },
              { value: 'direct', label: t('web:playerAccess.direct') },
            ]}
            data-testid="settings-default-expose"
            onChange={(value) => {
              if (value !== 'tailnet' && value !== 'direct') return;
              update.mutate({ 'servers.defaultExposeMode': value }, { onError });
            }}
          />
        </Group>
        <Group gap="sm" align="center">
          <Button
            size="xs"
            variant="default"
            loading={applyAll.isPending}
            data-testid="settings-expose-apply-all"
            onClick={() => {
              applyAll.mutate(mode, {
                onSuccess: (data) => {
                  notifications.show({
                    color: 'green',
                    message: t('web:playerExposure.applied', { count: data.updated }),
                  });
                },
                onError,
              });
            }}
          >
            {t('web:playerExposure.applyAll')}
          </Button>
          <Text size="xs" c="dimmed">
            {t('web:playerExposure.applyAllHint')}
          </Text>
        </Group>
      </Stack>
    </Card>
  );
}
