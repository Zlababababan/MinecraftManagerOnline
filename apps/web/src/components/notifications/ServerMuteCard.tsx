/**
 * Lot 8 — « Notifications » sur la vue d'ensemble d'un serveur : un interrupteur pour ne plus
 * faire sonner SON téléphone à cause de ce serveur-là. C'est une préférence personnelle posée
 * là où la question se pose (le serveur qui redémarre en boucle), pas un réglage du serveur —
 * un autre compte n'est pas concerné.
 */
import { Card, Group, Stack, Switch, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconBellOff } from '@tabler/icons-react';

import type { ServerDto } from '@mmo/protocol/client';

import { useServerMute, useSetServerMute } from '../../api/phase10.js';
import { useT } from '../../i18n/hooks.js';
import { describeError } from '../../lib/errors.js';

export function ServerMuteCard({ server }: { server: ServerDto }) {
  const { t, i18n } = useT();
  const query = useServerMute(server.id);
  const set = useSetServerMute(server.id);
  const muted = query.data?.muted ?? false;

  return (
    <Card withBorder radius="md" padding="md" data-testid="server-mute">
      <Stack gap="sm">
        <Group gap="xs">
          <IconBellOff size={18} />
          <Title order={2} size="h4">
            {t('web:notifications.serverMuteTitle')}
          </Title>
        </Group>
        <Switch
          label={t('web:notifications.serverMute')}
          description={t('web:notifications.serverMuteHint')}
          checked={muted}
          disabled={query.isPending || set.isPending}
          data-testid="server-mute-switch"
          onChange={(event) => {
            set.mutate(event.currentTarget.checked, {
              onError: (error) => {
                notifications.show({ color: 'red', message: describeError(i18n, error) });
              },
            });
          }}
        />
      </Stack>
    </Card>
  );
}
