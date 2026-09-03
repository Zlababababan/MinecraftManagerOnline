/**
 * Appareils connectés (lot 8) : chaque session cookie du compte — navigateur résumé, adresse,
 * dernière activité, « cet appareil » — avec déconnexion d'un appareil ou de tous les autres.
 * Déconnecter l'appareil courant recharge la page : le cookie est effacé, l'écran de connexion suit.
 */
import { Badge, Button, Card, Group, Stack, Table, Text, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconDevices, IconLogout } from '@tabler/icons-react';

import type { SessionDto } from '@mmo/protocol/client';

import { useRevokeOtherSessions, useRevokeSession, useSessions } from '../../api/sessions.js';
import { useT } from '../../i18n/hooks.js';
import { describeError } from '../../lib/errors.js';
import { formatDateTime } from '../../lib/format.js';
import { summarizeUserAgent } from '../../lib/user-agent.js';
import { ErrorAlert } from '../ErrorAlert.js';
import { HelpLink } from '../HelpLink.js';

export function SessionsCard({
  reload = () => {
    window.location.reload();
  },
}: {
  reload?: () => void;
}) {
  const { t, i18n } = useT();
  const sessions = useSessions();
  const revoke = useRevokeSession();
  const revokeOthers = useRevokeOtherSessions();
  const list = sessions.data?.sessions;
  const others = list?.filter((s) => !s.current).length ?? 0;

  const onRevoke = (session: SessionDto) => {
    revoke.mutate(session.id, {
      onSuccess: () => {
        if (session.current) {
          reload();
          return;
        }
        notifications.show({ color: 'teal', message: t('web:sessions.revoked') });
      },
      onError: (error) => {
        notifications.show({ color: 'red', message: describeError(i18n, error) });
      },
    });
  };

  return (
    <Card withBorder radius="md" padding="md" data-testid="sessions-card">
      <Stack gap="sm">
        <Group justify="space-between" align="flex-start">
          <div>
            <Title order={2} size="h4">
              <Group gap={6}>
                <IconDevices size={18} aria-hidden />
                {t('web:sessions.title')}
              </Group>
            </Title>
            <Text size="sm" c="dimmed">
              {t('web:sessions.hint')} <HelpLink topic="sessions" inline />
            </Text>
          </div>
          <Button
            size="xs"
            variant="default"
            leftSection={<IconLogout size={14} aria-hidden />}
            disabled={others === 0}
            loading={revokeOthers.isPending}
            onClick={() => {
              revokeOthers.mutate(undefined, {
                onSuccess: (data) => {
                  notifications.show({
                    color: 'teal',
                    message: t('web:sessions.revokedOthers', { count: data.revoked }),
                  });
                },
                onError: (error) => {
                  notifications.show({ color: 'red', message: describeError(i18n, error) });
                },
              });
            }}
            data-testid="sessions-revoke-others"
          >
            {t('web:sessions.revokeOthers')}
          </Button>
        </Group>
        <ErrorAlert error={sessions.error} />
        {list !== undefined && (
          <Table.ScrollContainer minWidth={560}>
            <Table verticalSpacing="xs" fz="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('web:sessions.device')}</Table.Th>
                  <Table.Th>{t('web:sessions.address')}</Table.Th>
                  <Table.Th>{t('web:sessions.lastSeen')}</Table.Th>
                  <Table.Th>{t('web:sessions.signedIn')}</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {list.map((session) => (
                  <Table.Tr key={session.id} data-testid={`session-row-${String(session.id)}`}>
                    <Table.Td>
                      <Group gap={6} wrap="nowrap">
                        <span>
                          {summarizeUserAgent(session.userAgent) ?? t('web:sessions.unknownDevice')}
                        </span>
                        {session.current && (
                          <Badge size="xs" variant="light" data-testid="session-current">
                            {t('web:sessions.thisDevice')}
                          </Badge>
                        )}
                      </Group>
                    </Table.Td>
                    <Table.Td>{session.ip ?? '—'}</Table.Td>
                    <Table.Td>
                      {session.lastSeenAt === null
                        ? '—'
                        : formatDateTime(session.lastSeenAt, i18n.language)}
                    </Table.Td>
                    <Table.Td>{formatDateTime(session.createdAt, i18n.language)}</Table.Td>
                    <Table.Td>
                      <Button
                        size="compact-xs"
                        variant="subtle"
                        color={session.current ? 'gray' : 'red'}
                        onClick={() => {
                          onRevoke(session);
                        }}
                        data-testid={`session-revoke-${String(session.id)}`}
                      >
                        {t('web:sessions.revoke')}
                      </Button>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </Stack>
    </Card>
  );
}
