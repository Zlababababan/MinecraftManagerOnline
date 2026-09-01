/**
 * Groupes de démarrage (lot 7) : modale de gestion depuis la vue de flotte. Un groupe démarre ses
 * membres dans l'ordre en attendant `running` avant le suivant (un proxy Velocity se met en
 * dernier), s'arrête en ordre inverse. L'ordre s'ajuste par flèches (renumérotation 0..n-1 par
 * PATCH serveurs successifs) ; l'ajout/le retrait passent par le même PATCH.
 */
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Modal,
  Select,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import {
  IconArrowDown,
  IconArrowUp,
  IconPlayerPlay,
  IconPlayerStop,
  IconPlus,
  IconRefresh,
  IconTrash,
  IconX,
} from '@tabler/icons-react';
import { useState } from 'react';

import type { GroupAction, ServerDto, ServerGroupDto } from '@mmo/protocol/client';

import {
  useAssignGroup,
  useCreateGroup,
  useDeleteGroup,
  useGroupAction,
  useGroups,
} from '../../api/groups.js';
import { useMe, useServers } from '../../api/queries.js';
import { RunStateBadge } from '../badges.js';
import { useT } from '../../i18n/hooks.js';
import { describeError } from '../../lib/errors.js';
import { hasRole } from '../../lib/format.js';

/** Membres d'un groupe dans l'ordre de démarrage (même tri que le panel). */
export function groupMembers(servers: ServerDto[], groupId: string): ServerDto[] {
  return servers
    .filter((s) => s.groupId === groupId)
    .sort((a, b) => a.groupPosition - b.groupPosition || a.name.localeCompare(b.name));
}

export function GroupsModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const { t, i18n } = useT();
  const me = useMe();
  const groups = useGroups();
  const servers = useServers();
  const create = useCreateGroup();
  const [newName, setNewName] = useState('');

  const isAdmin = me.data !== undefined && hasRole(me.data.user.role, 'admin');
  const rows = groups.data?.groups ?? [];
  const all = servers.data?.servers ?? [];
  const fail = (error: unknown): void => {
    notifications.show({ color: 'red', message: describeError(i18n, error) });
  };

  return (
    <Modal opened={opened} onClose={onClose} title={t('web:groups.title')} size="lg">
      <Stack gap="sm">
        <Text size="sm" c="dimmed">
          {t('web:groups.hint')}
        </Text>
        {rows.length === 0 && (
          <Text size="sm" c="dimmed" data-testid="groups-empty">
            {t('web:groups.none')}
          </Text>
        )}
        {rows.map((group) => (
          <GroupCard key={group.id} group={group} servers={all} isAdmin={isAdmin} onError={fail} />
        ))}
        {isAdmin && (
          <Group gap="xs" align="flex-end">
            <TextInput
              label={t('web:groups.newName')}
              placeholder={t('web:groups.namePlaceholder')}
              value={newName}
              onChange={(e) => {
                setNewName(e.currentTarget.value);
              }}
              style={{ flex: 1 }}
              data-testid="groups-new-name"
            />
            <Button
              type="button"
              leftSection={<IconPlus size={14} />}
              disabled={newName.trim() === ''}
              loading={create.isPending}
              onClick={() => {
                create.mutate(newName.trim(), {
                  onSuccess: () => {
                    setNewName('');
                  },
                  onError: fail,
                });
              }}
              data-testid="groups-create"
            >
              {t('web:groups.create')}
            </Button>
          </Group>
        )}
      </Stack>
    </Modal>
  );
}

function GroupCard({
  group,
  servers,
  isAdmin,
  onError,
}: {
  group: ServerGroupDto;
  servers: ServerDto[];
  isAdmin: boolean;
  onError: (error: unknown) => void;
}) {
  const { t } = useT();
  const action = useGroupAction();
  const assign = useAssignGroup();
  const remove = useDeleteGroup();
  const [adding, setAdding] = useState<string | null>(null);

  const members = groupMembers(servers, group.id);
  const candidates = servers.filter((s) => s.groupId !== group.id);

  const run = (kind: GroupAction): void => {
    action.mutate(
      { groupId: group.id, action: kind },
      {
        onSuccess: () => {
          notifications.show({ color: 'teal', message: t('web:groups.started') });
        },
        onError,
      },
    );
  };

  /** Renumérote 0..n-1 dans l'ordre voulu (séquentiel : chaque PATCH invalide la liste). */
  const applyOrder = async (ordered: ServerDto[]): Promise<void> => {
    for (const [index, server] of ordered.entries()) {
      if (server.groupPosition !== index) {
        await assign.mutateAsync({ serverId: server.id, groupPosition: index });
      }
    }
  };
  const move = (index: number, delta: -1 | 1): void => {
    const ordered = [...members];
    const [item] = ordered.splice(index, 1);
    if (!item) return;
    ordered.splice(index + delta, 0, item);
    applyOrder(ordered).catch(onError);
  };

  const confirmDelete = (): void => {
    modals.openConfirmModal({
      title: t('web:groups.delete'),
      children: <Text size="sm">{t('web:groups.deleteConfirm', { name: group.name })}</Text>,
      labels: { confirm: t('web:groups.delete'), cancel: t('web:common.cancel') },
      confirmProps: { color: 'red' },
      onConfirm: () => {
        remove.mutate(group.id, { onError });
      },
    });
  };

  return (
    <Card withBorder radius="md" padding="sm" data-testid={`group-${group.id}`}>
      <Stack gap="xs">
        <Group justify="space-between" wrap="wrap">
          <Group gap="xs">
            <Text fw={600}>{group.name}</Text>
            <Badge variant="light" size="sm">
              {t('web:groups.members', { count: members.length })}
            </Badge>
          </Group>
          <Group gap={4}>
            <Button
              type="button"
              size="compact-xs"
              variant="light"
              leftSection={<IconPlayerPlay size={12} />}
              disabled={members.length === 0}
              onClick={() => {
                run('start');
              }}
              data-testid={`group-start-${group.id}`}
            >
              {t('web:groups.start')}
            </Button>
            <Button
              type="button"
              size="compact-xs"
              variant="light"
              color="orange"
              leftSection={<IconPlayerStop size={12} />}
              disabled={members.length === 0}
              onClick={() => {
                run('stop');
              }}
              data-testid={`group-stop-${group.id}`}
            >
              {t('web:groups.stop')}
            </Button>
            <Button
              type="button"
              size="compact-xs"
              variant="light"
              color="grape"
              leftSection={<IconRefresh size={12} />}
              disabled={members.length === 0}
              onClick={() => {
                run('restart');
              }}
              data-testid={`group-restart-${group.id}`}
            >
              {t('web:groups.restart')}
            </Button>
            {isAdmin && (
              <Tooltip label={t('web:groups.delete')}>
                <ActionIcon
                  variant="subtle"
                  color="red"
                  onClick={confirmDelete}
                  aria-label={t('web:groups.delete')}
                  data-testid={`group-delete-${group.id}`}
                >
                  <IconTrash size={14} />
                </ActionIcon>
              </Tooltip>
            )}
          </Group>
        </Group>
        {members.length === 0 ? (
          <Text size="sm" c="dimmed">
            {t('web:groups.empty')}
          </Text>
        ) : (
          <Stack gap={4}>
            {members.map((server, index) => (
              <Group
                key={server.id}
                gap="xs"
                justify="space-between"
                data-testid={`group-member-${server.id}`}
              >
                <Group gap="xs">
                  <Badge variant="outline" size="sm" circle>
                    {index + 1}
                  </Badge>
                  <Text size="sm">{server.name}</Text>
                  <RunStateBadge server={server} size="sm" />
                </Group>
                {isAdmin && (
                  <Group gap={2}>
                    <ActionIcon
                      variant="subtle"
                      disabled={index === 0}
                      onClick={() => {
                        move(index, -1);
                      }}
                      aria-label={t('web:groups.moveUp')}
                      data-testid={`group-up-${server.id}`}
                    >
                      <IconArrowUp size={14} />
                    </ActionIcon>
                    <ActionIcon
                      variant="subtle"
                      disabled={index === members.length - 1}
                      onClick={() => {
                        move(index, 1);
                      }}
                      aria-label={t('web:groups.moveDown')}
                      data-testid={`group-down-${server.id}`}
                    >
                      <IconArrowDown size={14} />
                    </ActionIcon>
                    <ActionIcon
                      variant="subtle"
                      color="red"
                      onClick={() => {
                        assign.mutate({ serverId: server.id, groupId: null }, { onError });
                      }}
                      aria-label={t('web:groups.remove')}
                      data-testid={`group-remove-${server.id}`}
                    >
                      <IconX size={14} />
                    </ActionIcon>
                  </Group>
                )}
              </Group>
            ))}
          </Stack>
        )}
        {members.some((s) => s.loader === 'velocity') && members.at(-1)?.loader !== 'velocity' && (
          <Alert color="yellow" p="xs">
            {t('web:groups.velocityHint')}
          </Alert>
        )}
        {isAdmin && (
          <Group gap="xs">
            <Select
              placeholder={t('web:groups.addPlaceholder')}
              data={candidates.map((s) => ({ value: s.id, label: s.name }))}
              value={adding}
              onChange={setAdding}
              searchable
              clearable
              size="xs"
              style={{ flex: 1 }}
              data-testid={`group-add-select-${group.id}`}
            />
            <Button
              type="button"
              size="xs"
              variant="light"
              disabled={adding === null}
              onClick={() => {
                if (adding === null) return;
                assign.mutate(
                  { serverId: adding, groupId: group.id },
                  {
                    onSuccess: () => {
                      setAdding(null);
                    },
                    onError,
                  },
                );
              }}
              data-testid={`group-add-${group.id}`}
            >
              {t('web:groups.add')}
            </Button>
          </Group>
        )}
      </Stack>
    </Card>
  );
}
