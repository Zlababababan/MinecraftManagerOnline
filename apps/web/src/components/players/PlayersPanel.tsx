/**
 * Onglet Joueurs (phase 6) : en ligne (kick/ban/op), liste blanche, opérateurs, bannis (joueurs +
 * IP), historique des connexions. Jamais un fichier visible : chaque action passe par
 * `player.action` / `config.set` et l'agent choisit commandes ou fichiers selon l'état du serveur.
 */
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Group,
  Loader,
  Menu,
  NumberInput,
  SegmentedControl,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import {
  IconBan,
  IconDotsVertical,
  IconShield,
  IconShieldOff,
  IconTrash,
  IconUserPlus,
  IconUserX,
} from '@tabler/icons-react';
import { useState, type ReactNode, type SyntheticEvent } from 'react';

import type { PlayerActionKind } from '@mmo/protocol';
import type { PlayerActionRequest, ServerDto } from '@mmo/protocol/client';

import {
  useConfigFile,
  useMe,
  usePlayerAction,
  usePlayerHistory,
  usePlayers,
  useResolvePlayers,
  useSetConfig,
  type PlayerActionResult,
} from '../../api/queries.js';
import { tDynamic } from '../../i18n/index.js';
import { useT } from '../../i18n/hooks.js';
import { describeError } from '../../lib/errors.js';
import { formatDateTime, formatDuration, hasRole } from '../../lib/format.js';
import { ErrorAlert } from '../ErrorAlert.js';
import { PlayerAvatar } from './PlayerAvatar.js';

export const PLAYER_VIEWS = ['online', 'whitelist', 'ops', 'bans', 'history'] as const;
export type PlayerView = (typeof PLAYER_VIEWS)[number];

function useNotifyAction() {
  const { t, i18n } = useT();
  return {
    success: (res: PlayerActionResult) => {
      for (const w of res.warnings ?? []) {
        notifications.show({
          color: 'yellow',
          message: tDynamic(i18n, `web:server.players.warnings.${w}`),
        });
      }
      if ((res.warnings ?? []).length === 0) {
        notifications.show({
          color: 'teal',
          message: t(`web:server.players.applied.${res.applied}`),
        });
      }
    },
    error: (error: unknown) => {
      notifications.show({ color: 'red', message: describeError(i18n, error) });
    },
  };
}

/** Formulaire d'ajout par pseudo : résolution UUID (retour visible) puis action. */
function AddPlayerForm({
  server,
  action,
  withLevel,
  withReason,
  testId,
}: {
  server: ServerDto;
  action: Extract<PlayerActionKind, 'whitelistAdd' | 'op' | 'ban'>;
  withLevel?: boolean;
  withReason?: boolean;
  testId: string;
}) {
  const { t } = useT();
  const [name, setName] = useState('');
  const [reason, setReason] = useState('');
  const [level, setLevel] = useState<number | string>(4);
  const [hint, setHint] = useState<ReactNode>(null);
  const resolve = useResolvePlayers(server.id);
  const act = usePlayerAction(server.id);
  const notify = useNotifyAction();
  const busy = resolve.isPending || act.isPending;

  const submit = async (e: SyntheticEvent) => {
    e.preventDefault();
    const target = name.trim();
    if (target === '') return;
    setHint(
      <Text size="xs" c="dimmed">
        {t('web:server.players.resolving')}
      </Text>,
    );
    try {
      const r = await resolve.mutateAsync([target]);
      const p = r.players[0];
      if (p?.uuid === null || p === undefined) {
        setHint(
          <Text size="xs" c="red" data-testid={`${testId}-unresolved`}>
            {t('web:server.players.unresolved')}
          </Text>,
        );
        return;
      }
      const body: PlayerActionRequest = {
        action,
        target: p.name,
        ...(withReason && reason.trim() !== '' ? { reason: reason.trim() } : {}),
        ...(withLevel && typeof level === 'number' ? { level } : {}),
      };
      const res = await act.mutateAsync(body);
      notify.success(res);
      setHint(
        <Group gap={6} data-testid={`${testId}-resolved`}>
          <PlayerAvatar name={p.name} uuid={p.uuid} size={18} />
          <Text size="xs" c="dimmed">
            {p.name} · {t(`web:server.players.resolved.${p.source}`)}
          </Text>
        </Group>,
      );
      setName('');
      setReason('');
    } catch (error) {
      notify.error(error);
      setHint(null);
    }
  };

  return (
    <form
      onSubmit={(e) => {
        void submit(e);
      }}
      data-testid={testId}
    >
      <Stack gap={4}>
        <Group gap="xs" align="flex-end" wrap="wrap">
          <TextInput
            label={t('web:server.players.playerName')}
            value={name}
            onChange={(e) => {
              setName(e.currentTarget.value);
            }}
            maxLength={16}
            autoComplete="off"
            data-testid={`${testId}-name`}
            style={{ flex: '1 1 160px' }}
          />
          {withLevel && (
            <NumberInput
              label={t('web:server.players.level')}
              min={1}
              max={4}
              value={level}
              onChange={setLevel}
              w={90}
              data-testid={`${testId}-level`}
            />
          )}
          {withReason && (
            <TextInput
              label={t('web:server.players.reason')}
              value={reason}
              onChange={(e) => {
                setReason(e.currentTarget.value);
              }}
              maxLength={256}
              style={{ flex: '1 1 160px' }}
              data-testid={`${testId}-reason`}
            />
          )}
          <Button
            type="submit"
            leftSection={<IconUserPlus size={16} />}
            loading={busy}
            disabled={name.trim() === '' || !server.reachable}
            data-testid={`${testId}-submit`}
          >
            {t('web:common.add')}
          </Button>
        </Group>
        {hint}
      </Stack>
    </form>
  );
}

function RemoveButton({
  server,
  action,
  target,
  label,
}: {
  server: ServerDto;
  action: PlayerActionKind;
  target: string;
  label: string;
}) {
  const { t } = useT();
  const act = usePlayerAction(server.id);
  const notify = useNotifyAction();
  return (
    <Tooltip label={label}>
      <ActionIcon
        variant="subtle"
        color="red"
        aria-label={label}
        loading={act.isPending}
        disabled={!server.reachable}
        data-testid={`remove-${target}`}
        onClick={() => {
          modals.openConfirmModal({
            title: label,
            children: (
              <Text size="sm">{t('web:server.players.confirmRemove', { name: target })}</Text>
            ),
            labels: { confirm: t('web:common.confirm'), cancel: t('web:common.cancel') },
            confirmProps: { color: 'red', 'data-testid': 'confirm-remove' } as never,
            onConfirm: () => {
              act.mutate({ action, target }, { onSuccess: notify.success, onError: notify.error });
            },
          });
        }}
      >
        <IconTrash size={16} />
      </ActionIcon>
    </Tooltip>
  );
}

function PlayerCell({ name, uuid }: { name: string; uuid: string | null | undefined }) {
  return (
    <Group gap="xs" wrap="nowrap">
      <PlayerAvatar name={name} uuid={uuid} size={28} />
      <Stack gap={0}>
        <Text size="sm" fw={500}>
          {name}
        </Text>
        {uuid !== null && uuid !== undefined && (
          <Text size="xs" c="dimmed" ff="monospace" visibleFrom="sm">
            {uuid}
          </Text>
        )}
      </Stack>
    </Group>
  );
}

// --- Vues ---------------------------------------------------------------------------------------

function OnlineView({ server, canOperate }: { server: ServerDto; canOperate: boolean }) {
  const { t, i18n } = useT();
  const running = server.runState === 'running';
  const players = usePlayers(server.id, running);
  const act = usePlayerAction(server.id);
  const notify = useNotifyAction();
  const ops = useConfigFile(server.id, 'ops.json', canOperate);
  if (!running) {
    return (
      <Text size="sm" c="dimmed">
        {t('web:server.players.none')}
      </Text>
    );
  }
  if (players.isPending) return <Loader size="sm" />;
  if (players.error) return <ErrorAlert error={players.error} />;
  const list = players.data.players;
  const opNames = new Set((ops.data?.data ?? []).map((o) => o.name.toLowerCase()));
  const run = (action: PlayerActionKind, target: string, reason?: string) => {
    act.mutate(
      { action, target, ...(reason === undefined ? {} : { reason }) },
      { onSuccess: notify.success, onError: notify.error },
    );
  };
  const confirm = (action: 'kick' | 'ban', target: string) => {
    modals.openConfirmModal({
      title: t(`web:server.players.actions.${action}`),
      children: (
        <Text size="sm">
          {t(
            action === 'kick' ? 'web:server.players.confirmKick' : 'web:server.players.confirmBan',
            {
              name: target,
            },
          )}
        </Text>
      ),
      labels: { confirm: t('web:common.confirm'), cancel: t('web:common.cancel') },
      confirmProps: { color: 'red' },
      onConfirm: () => {
        run(action, target);
      },
    });
  };
  return (
    <Stack gap="sm" data-testid="players">
      <Text size="sm">{t('web:server.players.online', { online: players.data.online })}</Text>
      {list.length === 0 ? (
        <Text size="sm" c="dimmed">
          {t('web:server.players.none')}
        </Text>
      ) : (
        <Table striped withTableBorder>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t('web:server.players.name')}</Table.Th>
              <Table.Th>{t('web:server.players.history.joined')}</Table.Th>
              {canOperate && <Table.Th w={48} />}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {list.map((p) => (
              <Table.Tr key={p.name} data-testid={`online-${p.name}`}>
                <Table.Td>
                  <Group gap="xs">
                    <PlayerCell name={p.name} uuid={p.uuid} />
                    {opNames.has(p.name.toLowerCase()) && (
                      <Badge size="xs" variant="light" color="yellow">
                        OP
                      </Badge>
                    )}
                  </Group>
                </Table.Td>
                <Table.Td>{formatDateTime(p.joinedAt, i18n.language)}</Table.Td>
                {canOperate && (
                  <Table.Td>
                    <Menu position="bottom-end" withinPortal>
                      <Menu.Target>
                        <ActionIcon
                          variant="subtle"
                          aria-label={t('web:common.actions')}
                          data-testid={`online-actions-${p.name}`}
                        >
                          <IconDotsVertical size={16} />
                        </ActionIcon>
                      </Menu.Target>
                      <Menu.Dropdown>
                        <Menu.Item
                          leftSection={<IconUserX size={14} />}
                          onClick={() => {
                            confirm('kick', p.name);
                          }}
                        >
                          {t('web:server.players.actions.kick')}
                        </Menu.Item>
                        <Menu.Item
                          leftSection={<IconBan size={14} />}
                          color="red"
                          onClick={() => {
                            confirm('ban', p.name);
                          }}
                        >
                          {t('web:server.players.actions.ban')}
                        </Menu.Item>
                        <Menu.Divider />
                        {opNames.has(p.name.toLowerCase()) ? (
                          <Menu.Item
                            leftSection={<IconShieldOff size={14} />}
                            onClick={() => {
                              run('deop', p.name);
                            }}
                          >
                            {t('web:server.players.actions.deop')}
                          </Menu.Item>
                        ) : (
                          <Menu.Item
                            leftSection={<IconShield size={14} />}
                            onClick={() => {
                              run('op', p.name);
                            }}
                          >
                            {t('web:server.players.actions.op')}
                          </Menu.Item>
                        )}
                        <Menu.Item
                          leftSection={<IconUserPlus size={14} />}
                          onClick={() => {
                            run('whitelistAdd', p.name);
                          }}
                        >
                          {t('web:server.players.actions.whitelistAdd')}
                        </Menu.Item>
                      </Menu.Dropdown>
                    </Menu>
                  </Table.Td>
                )}
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Stack>
  );
}

function WhitelistView({ server, canOperate }: { server: ServerDto; canOperate: boolean }) {
  const { t, i18n } = useT();
  const list = useConfigFile(server.id, 'whitelist.json');
  const props = useConfigFile(server.id, 'server.properties');
  const setProps = useSetConfig(server.id, 'server.properties');
  const enabled = (props.data?.data['white-list'] ?? 'false').toLowerCase() === 'true';
  if (list.isPending) return <Loader size="sm" />;
  if (list.error) return <ErrorAlert error={list.error} />;
  const entries = list.data.data;
  return (
    <Stack gap="md" data-testid="whitelist">
      <Group justify="space-between" wrap="wrap">
        <Text size="sm" {...(enabled ? {} : { c: 'dimmed' })} data-testid="whitelist-status">
          {t(enabled ? 'web:server.players.whitelistOn' : 'web:server.players.whitelistOff')}
        </Text>
        {canOperate && (
          <Switch
            label={t('web:server.players.toggleWhitelist')}
            checked={enabled}
            disabled={props.isPending || setProps.isPending || !server.reachable}
            data-testid="whitelist-toggle"
            onChange={(e) => {
              setProps.mutate(
                { data: { 'white-list': e.currentTarget.checked ? 'true' : 'false' } },
                {
                  onError: (error) => {
                    notifications.show({ color: 'red', message: describeError(i18n, error) });
                  },
                },
              );
            }}
          />
        )}
      </Group>
      {canOperate && <AddPlayerForm server={server} action="whitelistAdd" testId="whitelist-add" />}
      {entries.length === 0 ? (
        <Text size="sm" c="dimmed" data-testid="whitelist-empty">
          {t('web:server.players.empty.whitelist')}
        </Text>
      ) : (
        <Table striped withTableBorder>
          <Table.Tbody>
            {entries.map((e) => (
              <Table.Tr key={e.uuid} data-testid={`whitelist-${e.name}`}>
                <Table.Td>
                  <PlayerCell name={e.name} uuid={e.uuid} />
                </Table.Td>
                {canOperate && (
                  <Table.Td w={48}>
                    <RemoveButton
                      server={server}
                      action="whitelistRemove"
                      target={e.name}
                      label={t('web:server.players.actions.whitelistRemove')}
                    />
                  </Table.Td>
                )}
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Stack>
  );
}

function OpsView({ server, canOperate }: { server: ServerDto; canOperate: boolean }) {
  const { t } = useT();
  const list = useConfigFile(server.id, 'ops.json');
  if (list.isPending) return <Loader size="sm" />;
  if (list.error) return <ErrorAlert error={list.error} />;
  const entries = list.data.data;
  return (
    <Stack gap="md" data-testid="ops">
      {canOperate && <AddPlayerForm server={server} action="op" withLevel testId="ops-add" />}
      {entries.length === 0 ? (
        <Text size="sm" c="dimmed">
          {t('web:server.players.empty.ops')}
        </Text>
      ) : (
        <Table striped withTableBorder>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t('web:server.players.name')}</Table.Th>
              <Table.Th>{t('web:server.players.level')}</Table.Th>
              {canOperate && <Table.Th w={48} />}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {entries.map((e) => (
              <Table.Tr key={e.uuid} data-testid={`ops-${e.name}`}>
                <Table.Td>
                  <PlayerCell name={e.name} uuid={e.uuid} />
                </Table.Td>
                <Table.Td>{e.level ?? '—'}</Table.Td>
                {canOperate && (
                  <Table.Td>
                    <RemoveButton
                      server={server}
                      action="deop"
                      target={e.name}
                      label={t('web:server.players.actions.deop')}
                    />
                  </Table.Td>
                )}
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Stack>
  );
}

function BansView({ server, canOperate }: { server: ServerDto; canOperate: boolean }) {
  const { t } = useT();
  const players = useConfigFile(server.id, 'banned-players.json');
  const ips = useConfigFile(server.id, 'banned-ips.json');
  const [ip, setIp] = useState('');
  const [ipReason, setIpReason] = useState('');
  const act = usePlayerAction(server.id);
  const notify = useNotifyAction();
  if (players.isPending || ips.isPending) return <Loader size="sm" />;
  if (players.error) return <ErrorAlert error={players.error} />;
  if (ips.error) return <ErrorAlert error={ips.error} />;
  const expires = (v: string | undefined) =>
    v === undefined || v === 'forever' ? t('web:server.players.forever') : v;
  return (
    <Stack gap="lg" data-testid="bans">
      <Stack gap="sm">
        <Text fw={600} size="sm">
          {t('web:server.players.bannedPlayers')}
        </Text>
        {canOperate && <AddPlayerForm server={server} action="ban" withReason testId="bans-add" />}
        {players.data.data.length === 0 ? (
          <Text size="sm" c="dimmed">
            {t('web:server.players.empty.bans')}
          </Text>
        ) : (
          <Table striped withTableBorder>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('web:server.players.name')}</Table.Th>
                <Table.Th>{t('web:server.players.reason')}</Table.Th>
                <Table.Th visibleFrom="sm">{t('web:server.players.expires')}</Table.Th>
                {canOperate && <Table.Th w={48} />}
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {players.data.data.map((e) => (
                <Table.Tr key={e.uuid} data-testid={`bans-${e.name}`}>
                  <Table.Td>
                    <PlayerCell name={e.name} uuid={e.uuid} />
                  </Table.Td>
                  <Table.Td>{e.reason ?? '—'}</Table.Td>
                  <Table.Td visibleFrom="sm">{expires(e.expires)}</Table.Td>
                  {canOperate && (
                    <Table.Td>
                      <RemoveButton
                        server={server}
                        action="pardon"
                        target={e.name}
                        label={t('web:server.players.actions.pardon')}
                      />
                    </Table.Td>
                  )}
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
      </Stack>
      <Stack gap="sm">
        <Text fw={600} size="sm">
          {t('web:server.players.bannedIps')}
        </Text>
        {canOperate && (
          <form
            data-testid="bans-ip-add"
            onSubmit={(e) => {
              e.preventDefault();
              const target = ip.trim();
              if (target === '') return;
              act.mutate(
                {
                  action: 'banIp',
                  target,
                  ...(ipReason.trim() === '' ? {} : { reason: ipReason.trim() }),
                },
                {
                  onSuccess: (res) => {
                    notify.success(res);
                    setIp('');
                    setIpReason('');
                  },
                  onError: notify.error,
                },
              );
            }}
          >
            <Group gap="xs" align="flex-end" wrap="wrap">
              <TextInput
                label={t('web:server.players.ip')}
                value={ip}
                onChange={(e) => {
                  setIp(e.currentTarget.value);
                }}
                style={{ flex: '1 1 160px' }}
                data-testid="bans-ip-input"
              />
              <TextInput
                label={t('web:server.players.reason')}
                value={ipReason}
                onChange={(e) => {
                  setIpReason(e.currentTarget.value);
                }}
                style={{ flex: '1 1 160px' }}
              />
              <Button
                type="submit"
                leftSection={<IconBan size={16} />}
                loading={act.isPending}
                disabled={ip.trim() === '' || !server.reachable}
              >
                {t('web:server.players.actions.banIp')}
              </Button>
            </Group>
          </form>
        )}
        {ips.data.data.length === 0 ? (
          <Text size="sm" c="dimmed">
            {t('web:server.players.empty.bannedIps')}
          </Text>
        ) : (
          <Table striped withTableBorder>
            <Table.Tbody>
              {ips.data.data.map((e) => (
                <Table.Tr key={e.ip} data-testid={`bans-ip-${e.ip}`}>
                  <Table.Td>
                    <Text size="sm" ff="monospace">
                      {e.ip}
                    </Text>
                  </Table.Td>
                  <Table.Td>{e.reason ?? '—'}</Table.Td>
                  {canOperate && (
                    <Table.Td w={48}>
                      <RemoveButton
                        server={server}
                        action="pardonIp"
                        target={e.ip}
                        label={t('web:server.players.actions.pardonIp')}
                      />
                    </Table.Td>
                  )}
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
      </Stack>
    </Stack>
  );
}

function HistoryView({ server }: { server: ServerDto }) {
  const { t, i18n } = useT();
  const history = usePlayerHistory(server.id);
  if (history.isPending) return <Loader size="sm" />;
  if (history.error) return <ErrorAlert error={history.error} />;
  const sessions = history.data.sessions;
  if (sessions.length === 0) {
    return (
      <Text size="sm" c="dimmed">
        {t('web:server.players.empty.history')}
      </Text>
    );
  }
  return (
    <Table striped withTableBorder data-testid="player-history">
      <Table.Thead>
        <Table.Tr>
          <Table.Th>{t('web:server.players.name')}</Table.Th>
          <Table.Th>{t('web:server.players.history.joined')}</Table.Th>
          <Table.Th>{t('web:server.players.history.left')}</Table.Th>
          <Table.Th visibleFrom="sm">{t('web:server.players.history.duration')}</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {sessions.map((s) => (
          <Table.Tr key={s.id}>
            <Table.Td>
              <PlayerCell name={s.playerName} uuid={s.playerUuid} />
            </Table.Td>
            <Table.Td>{formatDateTime(s.joinedAt, i18n.language)}</Table.Td>
            <Table.Td>
              {s.leftAt === null ? (
                <Badge size="sm" color="green" variant="light">
                  {t('web:server.players.history.stillOnline')}
                </Badge>
              ) : (
                formatDateTime(s.leftAt, i18n.language)
              )}
            </Table.Td>
            <Table.Td visibleFrom="sm">
              {s.leftAt === null ? '—' : formatDuration(s.leftAt - s.joinedAt)}
            </Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}

export function PlayersPanel({ server }: { server: ServerDto }) {
  const { t } = useT();
  const me = useMe();
  const [view, setView] = useState<PlayerView>('online');
  const canOperate =
    me.data !== undefined && hasRole(me.data.user.role, 'operator') && server.reachable;
  const props = useConfigFile(server.id, 'server.properties');
  const offline = (props.data?.data['online-mode'] ?? 'true').toLowerCase() === 'false';
  return (
    <Stack gap="md">
      <SegmentedControl
        value={view}
        onChange={(v) => {
          setView(v as PlayerView);
        }}
        data={PLAYER_VIEWS.map((v) => ({
          value: v,
          label: (
            <span data-testid={`players-view-${v}`}>{t(`web:server.players.views.${v}`)}</span>
          ),
        }))}
        fullWidth
        size="xs"
      />
      {!server.reachable && (
        <Alert color="orange" variant="light">
          {t('web:server.unreachable')}
        </Alert>
      )}
      {offline && view !== 'history' && (
        <Text size="xs" c="dimmed">
          {t('web:server.players.offlineHint')}
        </Text>
      )}
      {view === 'online' && <OnlineView server={server} canOperate={canOperate} />}
      {view === 'whitelist' && <WhitelistView server={server} canOperate={canOperate} />}
      {view === 'ops' && <OpsView server={server} canOperate={canOperate} />}
      {view === 'bans' && <BansView server={server} canOperate={canOperate} />}
      {view === 'history' && <HistoryView server={server} />}
    </Stack>
  );
}
