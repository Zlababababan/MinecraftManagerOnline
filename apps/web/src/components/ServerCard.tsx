/** Carte serveur (tableau de bord, page machine, vue de flotte) : nom, loader/version, état, port, actions. */
import { Card, Checkbox, Group, Stack, Text } from '@mantine/core';
import { RouterAnchor } from './links.js';
import { useT } from '../i18n/hooks.js';

import type { ServerDto } from '@mmo/protocol/client';

import { formatMb } from '../lib/format.js';
import { RunStateBadge } from './badges.js';
import { ServerActions } from './ServerActions.js';

export function serverSubtitle(
  server: Pick<ServerDto, 'loader' | 'mcVersion' | 'loaderVersion'>,
  loaderLabel: string,
): string {
  const parts = [loaderLabel];
  if (server.mcVersion !== null) parts.push(server.mcVersion);
  if (server.loaderVersion !== null && server.loader !== 'vanilla') {
    parts.push(`(${server.loaderVersion})`);
  }
  return parts.join(' ');
}

export function ServerCard({
  server,
  selectable,
  selected,
  onSelectedChange,
}: {
  server: ServerDto;
  /** Vue de flotte : la carte participe alors aux actions groupées. */
  selectable?: boolean;
  selected?: boolean;
  onSelectedChange?: (next: boolean) => void;
}) {
  const { t } = useT();
  return (
    <Card withBorder radius="md" padding="md" data-testid="server-card" data-server-id={server.id}>
      <Stack gap="xs">
        <Group justify="space-between" wrap="nowrap" align="flex-start">
          <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
            {selectable === true && (
              <Checkbox
                checked={selected ?? false}
                onChange={(e) => {
                  onSelectedChange?.(e.currentTarget.checked);
                }}
                aria-label={t('web:servers.bulk.selectOne', { name: server.name })}
                data-testid={`server-card-select-${server.id}`}
              />
            )}
            <Stack gap={2} style={{ minWidth: 0 }}>
              <RouterAnchor
                to="/servers/$serverId"
                params={{ serverId: server.id }}
                fw={600}
                size="md"
                truncate="end"
                data-testid="server-link"
              >
                {server.name}
              </RouterAnchor>
              <Text size="xs" c="dimmed" truncate="end">
                {serverSubtitle(server, t(`common:loader.${server.loader}`))}
              </Text>
            </Stack>
          </Group>
          <RunStateBadge server={server} />
        </Group>
        <Group gap="md">
          <Text size="xs" c="dimmed">
            {t('web:server.fields.gamePort')} : {server.gamePort ?? '—'}
          </Text>
          <Text size="xs" c="dimmed">
            {t('web:server.fields.ram')} : {formatMb(server.maxRamMb)}
          </Text>
          {server.javaMajorRequired !== null && (
            <Text size="xs" c="dimmed">
              Java {server.javaMajorRequired}
            </Text>
          )}
        </Group>
        <ServerActions server={server} />
      </Stack>
    </Card>
  );
}
