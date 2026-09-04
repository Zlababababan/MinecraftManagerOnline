/**
 * Lot 8 — les demandes de whitelist reçues depuis la page de statut publique, posées en tête de
 * la vue « Liste blanche » : c'est là qu'on regarde quand on se demande qui attend.
 *
 * La carte ne s'affiche que s'il y a quelque chose à montrer. Les demandes en attente sont en
 * haut ; celles déjà tranchées restent en dessous, avec un bouton pour les oublier — oublier une
 * demande refusée est la seule façon de permettre à quelqu'un d'en refaire une.
 */
import { ActionIcon, Badge, Button, Card, Group, Stack, Table, Text, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconCheck, IconTrash, IconUserQuestion, IconX } from '@tabler/icons-react';

import type { ServerDto, WhitelistRequestDto } from '@mmo/protocol/client';

import {
  useDecideWhitelistRequest,
  useDeleteWhitelistRequest,
  useWhitelistRequests,
} from '../../api/whitelist-requests.js';
import { useT } from '../../i18n/hooks.js';
import { describeError } from '../../lib/errors.js';
import { formatDateTime } from '../../lib/format.js';
import { HelpLink } from '../HelpLink.js';
import { PlayerAvatar } from './PlayerAvatar.js';

export function WhitelistRequestsCard({
  server,
  canOperate,
}: {
  server: ServerDto;
  canOperate: boolean;
}) {
  const { t, i18n } = useT();
  const query = useWhitelistRequests(server.id);
  const decide = useDecideWhitelistRequest(server.id);
  const remove = useDeleteWhitelistRequest(server.id);
  const requests = query.data?.requests ?? [];
  const pending = requests.filter((r) => r.status === 'pending');
  const handled = requests.filter((r) => r.status !== 'pending');
  const onError = (error: unknown) => {
    notifications.show({ color: 'red', message: describeError(i18n, error) });
  };

  if (requests.length === 0) return null;

  const row = (request: WhitelistRequestDto) => (
    <Table.Tr key={request.id} data-testid={`whitelist-request-${request.name}`}>
      <Table.Td>
        <Group gap="xs" wrap="nowrap">
          <PlayerAvatar name={request.name} uuid={null} size={28} />
          <Stack gap={0}>
            <Text size="sm" fw={500}>
              {request.name}
            </Text>
            {request.note !== null && (
              <Text size="xs" c="dimmed" data-testid={`whitelist-request-note-${request.name}`}>
                {request.note}
              </Text>
            )}
          </Stack>
        </Group>
      </Table.Td>
      <Table.Td visibleFrom="sm">
        <Text size="xs" c="dimmed">
          {formatDateTime(request.createdAt, i18n.language)}
        </Text>
      </Table.Td>
      <Table.Td>
        {request.status === 'pending' ? (
          canOperate && (
            <Group gap="xs" wrap="nowrap" justify="flex-end">
              <Button
                size="compact-xs"
                color="teal"
                leftSection={<IconCheck size={14} />}
                loading={decide.isPending}
                data-testid={`whitelist-accept-${request.name}`}
                onClick={() => {
                  decide.mutate({ id: request.id, accept: true }, { onError });
                }}
              >
                {t('web:server.players.requests.accept')}
              </Button>
              <Button
                size="compact-xs"
                variant="default"
                leftSection={<IconX size={14} />}
                loading={decide.isPending}
                data-testid={`whitelist-reject-${request.name}`}
                onClick={() => {
                  decide.mutate({ id: request.id, accept: false }, { onError });
                }}
              >
                {t('web:server.players.requests.reject')}
              </Button>
            </Group>
          )
        ) : (
          <Group gap="xs" wrap="nowrap" justify="flex-end">
            <Badge
              size="sm"
              variant="light"
              color={request.status === 'accepted' ? 'teal' : 'gray'}
              data-testid={`whitelist-request-status-${request.name}`}
            >
              {t(`web:server.players.requests.${request.status}`)}
              {request.decidedBy === null
                ? ''
                : ` · ${t('web:server.players.requests.decidedBy', { user: request.decidedBy })}`}
            </Badge>
            {canOperate && (
              <Tooltip label={t('web:server.players.requests.forget')}>
                <ActionIcon
                  variant="subtle"
                  color="red"
                  aria-label={t('web:server.players.requests.forget')}
                  loading={remove.isPending}
                  data-testid={`whitelist-forget-${request.name}`}
                  onClick={() => {
                    remove.mutate(request.id, { onError });
                  }}
                >
                  <IconTrash size={16} />
                </ActionIcon>
              </Tooltip>
            )}
          </Group>
        )}
      </Table.Td>
    </Table.Tr>
  );

  return (
    <Card withBorder radius="md" padding="md" data-testid="whitelist-requests">
      <Stack gap="sm">
        <Group gap="xs">
          <IconUserQuestion size={18} />
          <Text fw={600} size="sm">
            {t('web:server.players.requests.title')}
          </Text>
          <HelpLink topic="whitelistRequests" />
          {pending.length > 0 && (
            <Badge size="sm" color="orange" data-testid="whitelist-requests-count">
              {pending.length}
            </Badge>
          )}
        </Group>
        <Text size="xs" c="dimmed">
          {t('web:server.players.requests.hint')}
        </Text>
        {pending.length > 0 && (
          <Table withTableBorder>
            <Table.Tbody>{pending.map(row)}</Table.Tbody>
          </Table>
        )}
        {handled.length > 0 && (
          <>
            <Text size="xs" c="dimmed" fw={600}>
              {t('web:server.players.requests.handled')}
            </Text>
            <Table>
              <Table.Tbody>{handled.map(row)}</Table.Tbody>
            </Table>
          </>
        )}
      </Stack>
    </Card>
  );
}
