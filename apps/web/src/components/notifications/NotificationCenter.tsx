/**
 * Phase 10 — centre de notifications in-app (repli du push, doc 03 §11) : cloche dans l'en-tête avec
 * le nombre de non-lus, tiroir listant les événements retenus par les préférences de l'utilisateur,
 * « tout marquer comme lu » (curseur `notifications_seen_id`), clic → page du serveur / de la machine.
 */
import {
  ActionIcon,
  Badge,
  Button,
  Drawer,
  Group,
  Indicator,
  Stack,
  Text,
  UnstyledButton,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconBell } from '@tabler/icons-react';
import { useNavigate } from '@tanstack/react-router';

import type { EventDto } from '@mmo/protocol/client';

import { useMarkNotificationsSeen, useNotifications } from '../../api/phase10.js';
import { useMachines, useServers } from '../../api/queries.js';
import { useT } from '../../i18n/hooks.js';
import { tDynamic } from '../../i18n/index.js';
import { formatDateTime } from '../../lib/format.js';
import { SeverityBadge } from '../badges.js';
import { eventLabel } from '../EventsList.js';

export function NotificationCenter() {
  const { t, i18n } = useT();
  const [opened, { open, close }] = useDisclosure(false);
  const navigate = useNavigate();
  const query = useNotifications();
  const markSeen = useMarkNotificationsSeen();
  const servers = useServers();
  const machines = useMachines();
  const unread = query.data?.unread ?? 0;
  const items = query.data?.notifications ?? [];
  const seenId = query.data?.seenId ?? 0;

  const resolveName = (e: EventDto): string | undefined => {
    if (e.serverId !== null) return servers.data?.servers.find((s) => s.id === e.serverId)?.name;
    if (e.machineId !== null)
      return machines.data?.machines.find((m) => m.id === e.machineId)?.name;
    return undefined;
  };
  const label = (e: EventDto): string =>
    eventLabel(
      (k, o) => tDynamic(i18n, k, o),
      e,
      (k) => i18n.exists(k),
    );

  const onOpen = (e: EventDto): void => {
    close();
    // Cliquer une notification la marque vue (elle et les plus anciennes : curseur `seenId`) —
    // la pastille ne doit pas survivre à un clic sur la notification la plus récente.
    if (e.id > seenId) markSeen.mutate(e.id);
    if (e.serverId !== null)
      void navigate({ to: '/servers/$serverId', params: { serverId: e.serverId } });
    else if (e.machineId !== null)
      void navigate({ to: '/machines/$machineId', params: { machineId: e.machineId } });
  };

  return (
    <>
      <Indicator
        label={unread > 99 ? '99+' : String(unread)}
        size={16}
        color="red"
        disabled={unread === 0}
        data-testid="notifications-indicator"
        data-unread={unread}
      >
        <ActionIcon
          variant="subtle"
          color="gray"
          aria-label={t('web:notifications.open')}
          onClick={open}
          data-testid="notifications-open"
        >
          <IconBell size={20} />
        </ActionIcon>
      </Indicator>
      <Drawer
        opened={opened}
        onClose={close}
        position="right"
        title={t('web:notifications.title')}
        size="md"
        data-testid="notifications-drawer"
      >
        <Stack gap="sm">
          <Group justify="space-between">
            <Text size="sm" c="dimmed" data-testid="notifications-unread">
              {t('web:notifications.unread', { count: unread })}
            </Text>
            <Button
              type="button"
              size="compact-xs"
              variant="light"
              disabled={unread === 0 || items.length === 0}
              loading={markSeen.isPending}
              onClick={() => {
                const top = items[0];
                if (top !== undefined) markSeen.mutate(top.id);
              }}
              data-testid="notifications-mark-seen"
            >
              {t('web:notifications.markSeen')}
            </Button>
          </Group>
          {items.length === 0 && (
            <Text size="sm" c="dimmed" data-testid="notifications-empty">
              {t('web:notifications.empty')}
            </Text>
          )}
          {items.map((e) => {
            const name = resolveName(e);
            const isNew = e.id > seenId;
            return (
              <UnstyledButton
                key={e.id}
                onClick={() => {
                  onOpen(e);
                }}
                data-testid={`notification-${String(e.id)}`}
                data-unread={isNew}
                style={{
                  padding: 8,
                  borderRadius: 8,
                  background: isNew ? 'var(--mantine-color-default-hover)' : undefined,
                }}
              >
                <Group gap="xs" wrap="nowrap" align="flex-start">
                  <SeverityBadge severity={e.severity} />
                  <Stack gap={2} style={{ flex: 1 }}>
                    <Text size="sm" fw={isNew ? 600 : 400}>
                      {label(e)}
                    </Text>
                    <Group gap="xs">
                      {name !== undefined && (
                        <Badge size="xs" variant="outline">
                          {name}
                        </Badge>
                      )}
                      <Text size="xs" c="dimmed">
                        {formatDateTime(e.ts, i18n.language)}
                      </Text>
                    </Group>
                  </Stack>
                </Group>
              </UnstyledButton>
            );
          })}
        </Stack>
      </Drawer>
    </>
  );
}
