/**
 * Carte serveur (tableau de bord, vue de flotte) : nom, loader/version, état, port, et les gestes
 * les plus fréquents sous la main (passe UX du 01/10) — démarrer/arrêter, ouvrir la console,
 * copier l'adresse à donner aux amis, épingler en favori.
 */
import {
  ActionIcon,
  Badge,
  Button,
  Card,
  Checkbox,
  Group,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconCopy, IconStar, IconStarFilled, IconTerminal2 } from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import type { ServerDto } from '@mmo/protocol/client';

import { serverAddressQuery } from '../api/phase10.js';
import { useMe, useSetFavorite } from '../api/queries.js';
import { useT } from '../i18n/hooks.js';
import { copyText } from '../lib/clipboard.js';
import { describeError } from '../lib/errors.js';
import { formatMb } from '../lib/format.js';
import { canServer } from '../lib/permissions.js';
import { RunStateBadge } from './badges.js';
import { JoinStatus } from './JoinStatus.js';
import { RouterAnchor, RouterButton } from './links.js';
import { ServerActions } from './ServerActions.js';

/** Le port que Minecraft essaie quand on tape une adresse sans port. */
export const DEFAULT_GAME_PORT = 25565;

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

/**
 * L'étoile : pleine si le serveur est épinglé. Cliquable pour qui peut l'opérer ; les autres ne
 * voient que les étoiles pleines (une étoile vide sans geste derrière ne dirait rien).
 */
export function FavoriteStar({ server }: { server: ServerDto }) {
  const { t, i18n } = useT();
  const me = useMe();
  const setFavorite = useSetFavorite(server.id);
  const favorite = server.favorite === true;
  if (!canServer(me.data, server, 'operator')) {
    return favorite ? (
      <IconStarFilled size={16} color="var(--mantine-color-yellow-5)" data-testid="favorite-mark" />
    ) : null;
  }
  const label = favorite
    ? t('web:servers.card.favoriteRemove', { name: server.name })
    : t('web:servers.card.favoriteAdd', { name: server.name });
  return (
    <Tooltip label={label} withArrow>
      <ActionIcon
        variant="subtle"
        color={favorite ? 'yellow' : 'gray'}
        size="sm"
        aria-label={label}
        aria-pressed={favorite}
        loading={setFavorite.isPending}
        onClick={() => {
          setFavorite.mutate(!favorite, {
            onError: (error) => {
              notifications.show({ color: 'red', message: describeError(i18n, error) });
            },
          });
        }}
        data-testid={`favorite-${server.id}`}
      >
        {favorite ? <IconStarFilled size={16} /> : <IconStar size={16} />}
      </ActionIcon>
    </Tooltip>
  );
}

/**
 * Copier l'adresse à donner aux amis. Elle est demandée au panel AU CLIC (c'est lui qui sait
 * laquelle donner : hôte de la machine, domaine, IPv6 détectée) — pas pour chaque carte affichée.
 */
function CopyAddressButton({ server }: { server: ServerDto }) {
  const { t, i18n } = useT();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const copy = async (): Promise<void> => {
    setBusy(true);
    try {
      const { address } = await queryClient.fetchQuery(serverAddressQuery(server.id));
      if (address.address === null) {
        notifications.show({ color: 'orange', message: t('web:servers.card.noAddress') });
        return;
      }
      const copied = await copyText(address.address);
      notifications.show({
        color: copied ? 'teal' : 'blue',
        message: copied
          ? t('web:servers.card.addressCopied', { address: address.address })
          : t('web:servers.card.addressShown', { address: address.address }),
      });
    } catch (error) {
      notifications.show({ color: 'red', message: describeError(i18n, error) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Tooltip label={t('web:servers.card.copyAddressHint')} withArrow>
      <Button
        size="xs"
        px={8}
        variant="default"
        leftSection={<IconCopy size={16} />}
        loading={busy}
        onClick={() => {
          void copy();
        }}
        data-testid="card-copy-address"
      >
        {t('web:servers.card.copyAddress')}
      </Button>
    </Tooltip>
  );
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
    <Card
      withBorder
      radius="md"
      padding="md"
      data-testid="server-card"
      data-server-id={server.id}
      data-favorite={server.favorite === true}
    >
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
          <Group gap={6} wrap="nowrap">
            <RunStateBadge server={server} />
            <FavoriteStar server={server} />
          </Group>
        </Group>
        <Group gap="md" align="center">
          {server.gamePort !== null && server.gamePort !== DEFAULT_GAME_PORT ? (
            // Port inhabituel : il faut le taper dans Minecraft, donc il se voit, serveur arrêté ou non.
            <Badge variant="default" size="sm" className="mmo-warn-text" data-testid="card-port">
              {t('web:servers.card.port', { port: server.gamePort })}
            </Badge>
          ) : (
            <Text size="xs" c="dimmed">
              {t('web:server.fields.gamePort')} : {server.gamePort ?? '—'}
            </Text>
          )}
          <Text size="xs" c="dimmed">
            {t('web:server.fields.ram')} : {formatMb(server.maxRamMb)}
          </Text>
          {server.javaMajorRequired !== null && (
            <Text size="xs" c="dimmed">
              Java {server.javaMajorRequired}
            </Text>
          )}
        </Group>
        <JoinStatus server={server} />
        {/* Serré exprès : Démarrer + Console + Adresse tiennent sur une ligne dans une carte étroite. */}
        <Group gap={6} wrap="wrap">
          <ServerActions server={server} />
          <RouterButton
            to="/servers/$serverId"
            params={{ serverId: server.id }}
            search={{ tab: 'console' }}
            size="xs"
            px={8}
            variant="default"
            leftSection={<IconTerminal2 size={16} />}
            data-testid="card-console"
          >
            {t('web:servers.card.console')}
          </RouterButton>
          <CopyAddressButton server={server} />
        </Group>
      </Stack>
    </Card>
  );
}
