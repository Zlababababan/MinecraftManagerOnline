/** Page serveur : en-tête (état temps réel, actions), onglets aperçu / console / joueurs / événements / réglages. */
import {
  Alert,
  Button,
  Card,
  Group,
  Loader,
  NumberInput,
  SimpleGrid,
  Stack,
  Switch,
  Table,
  Tabs,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { IconTrash } from '@tabler/icons-react';
import { useNavigate } from '@tanstack/react-router';
import { Suspense, lazy } from 'react';
import { RouterAnchor } from '../components/links.js';
import type { ReactNode } from 'react';
import { useT } from '../i18n/hooks.js';

import type { ServerDto } from '@mmo/protocol/client';
import { translateEvidence } from '@mmo/shared';

import {
  useAcceptEula,
  useDeleteServer,
  useEvents,
  useMachines,
  useMe,
  usePlayers,
  useServer,
  useUpdateServer,
} from '../api/queries.js';

import { ErrorAlert } from '../components/ErrorAlert.js';
import { EventsList } from '../components/EventsList.js';
import { RunStateBadge } from '../components/badges.js';
import { ServerActions } from '../components/ServerActions.js';
import { serverSubtitle } from '../components/ServerCard.js';
import { describeError } from '../lib/errors.js';
import { formatDateTime, formatMb, hasRole } from '../lib/format.js';

// xterm (lourd) n'est chargé qu'à l'ouverture de l'onglet Console.
const ConsolePanel = lazy(() =>
  import('../components/console/ConsolePanel.js').then((m) => ({ default: m.ConsolePanel })),
);

export const SERVER_TABS = ['overview', 'console', 'players', 'events', 'settings'] as const;
export type ServerTab = (typeof SERVER_TABS)[number];

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <Stack gap={0}>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text size="sm" style={{ wordBreak: 'break-all' }}>
        {value}
      </Text>
    </Stack>
  );
}

function Overview({ server }: { server: ServerDto }) {
  const { t, i18n } = useT();
  const machines = useMachines();
  const me = useMe();
  const eula = useAcceptEula(server.id);
  const machineName = machines.data?.machines.find((m) => m.id === server.machineId)?.name;
  const canOperate = me.data !== undefined && hasRole(me.data.user.role, 'operator');
  const detection = server.detection;
  return (
    <Stack gap="md">
      {!server.eulaAccepted && (
        <Alert color="yellow" variant="light" data-testid="eula-alert">
          <Group justify="space-between">
            <Text size="sm">{t('web:server.eulaHint')}</Text>
            {canOperate && (
              <Button
                size="xs"
                onClick={() => {
                  eula.mutate(undefined, {
                    onError: (error) => {
                      notifications.show({ color: 'red', message: describeError(i18n, error) });
                    },
                  });
                }}
                loading={eula.isPending}
                disabled={!server.reachable}
              >
                {t('web:server.acceptEula')}
              </Button>
            )}
          </Group>
        </Alert>
      )}
      <SimpleGrid cols={{ base: 1, xs: 2, md: 3 }} spacing="md">
        <Field
          label={t('web:server.fields.machine')}
          value={
            <RouterAnchor to="/machines/$machineId" params={{ machineId: server.machineId }}>
              {machineName ?? server.machineId}
            </RouterAnchor>
          }
        />
        <Field label={t('web:server.fields.path')} value={server.path} />
        <Field label={t('web:server.fields.loader')} value={t(`common:loader.${server.loader}`)} />
        <Field label={t('web:server.fields.mcVersion')} value={server.mcVersion ?? '—'} />
        <Field label={t('web:server.fields.loaderVersion')} value={server.loaderVersion ?? '—'} />
        <Field
          label={t('web:server.fields.java')}
          value={
            server.javaMajorRequired === null ? '—' : `Java ${String(server.javaMajorRequired)}`
          }
        />
        <Field
          label={t('web:server.fields.ram')}
          value={`${formatMb(server.minRamMb)} → ${formatMb(server.maxRamMb)}`}
        />
        <Field label={t('web:server.fields.gamePort')} value={server.gamePort ?? '—'} />
        <Field
          label={t('web:server.fields.rcon')}
          value={
            server.rconEnabled
              ? `${t('web:common.yes')} (${String(server.rconPort ?? '?')})`
              : t('web:common.no')
          }
        />
        <Field
          label={t('web:server.fields.eula')}
          value={server.eulaAccepted ? t('web:common.yes') : t('web:common.no')}
        />
        <Field label={t('web:server.fields.pid')} value={server.pid ?? '—'} />
        <Field
          label={t('web:server.fields.attach')}
          value={t(`common:attachMode.${server.attachMode}`)}
        />
        <Field
          label={t('web:server.fields.startedAt')}
          value={formatDateTime(server.startedAt, i18n.language)}
        />
        <Field
          label={t('web:server.fields.stoppedAt')}
          value={formatDateTime(server.stoppedAt, i18n.language)}
        />
        <Field
          label={t('web:server.fields.exitReason')}
          value={
            server.lastExitReason === null
              ? '—'
              : t(`web:server.exitReason.${server.lastExitReason}`)
          }
        />
        <Field
          label={t('web:server.fields.autoRestart')}
          value={server.autoRestart ? t('web:common.yes') : t('web:common.no')}
        />
        <Field
          label={t('web:server.fields.desiredState')}
          value={t(`common:runState.${server.desiredState}`)}
        />
      </SimpleGrid>
      {detection !== undefined && (
        <Card withBorder radius="sm" padding="sm">
          <Stack gap={4}>
            <Group gap="xs">
              <Text fw={600} size="sm">
                {t('web:server.fields.detection')}
              </Text>
              <Text size="xs" c="dimmed">
                {t(`common:confidence.${detection.confidence}`)}
              </Text>
            </Group>
            {detection.evidence.map((ev, i) => (
              <Text key={`${ev.code}-${String(i)}`} size="xs" c="dimmed">
                • {translateEvidence(i18n, ev)}
              </Text>
            ))}
          </Stack>
        </Card>
      )}
    </Stack>
  );
}

function Players({ server }: { server: ServerDto }) {
  const { t, i18n } = useT();
  const players = usePlayers(server.id, server.runState === 'running');
  if (server.runState !== 'running') {
    return (
      <Text size="sm" c="dimmed">
        {t('web:server.players.none')}
      </Text>
    );
  }
  if (players.isPending) return <Loader size="sm" />;
  if (players.error) return <ErrorAlert error={players.error} />;
  const list = players.data.players;
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
              <Table.Th>UUID</Table.Th>
              <Table.Th>{t('web:server.fields.startedAt')}</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {list.map((p) => (
              <Table.Tr key={p.name}>
                <Table.Td>{p.name}</Table.Td>
                <Table.Td>
                  <Text size="xs" ff="monospace">
                    {p.uuid ?? '—'}
                  </Text>
                </Table.Td>
                <Table.Td>{formatDateTime(p.joinedAt, i18n.language)}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Stack>
  );
}

function Settings({ server }: { server: ServerDto }) {
  const { t, i18n } = useT();
  const me = useMe();
  const update = useUpdateServer(server.id);
  const remove = useDeleteServer();
  const navigate = useNavigate();
  const isAdmin = me.data !== undefined && hasRole(me.data.user.role, 'admin');
  const form = useForm({
    initialValues: {
      name: server.name,
      minRamMb: server.minRamMb,
      maxRamMb: server.maxRamMb,
      autoRestart: server.autoRestart,
    },
    validate: {
      name: (v) => (v.trim() === '' ? t('web:errors.validation') : null),
      maxRamMb: (v, values) => (v < values.minRamMb ? t('web:errors.validation') : null),
    },
  });
  if (!isAdmin) {
    return (
      <Text size="sm" c="dimmed">
        {t('web:server.settings.adminOnly')}
      </Text>
    );
  }
  const submit = form.onSubmit((values) => {
    update.mutate(values, {
      onSuccess: () => {
        notifications.show({ color: 'teal', message: t('web:server.settings.saved') });
      },
      onError: (error) => {
        notifications.show({ color: 'red', message: describeError(i18n, error) });
      },
    });
  });
  const confirmDelete = (): void => {
    modals.openConfirmModal({
      title: t('web:server.delete'),
      children: <Text size="sm">{t('web:server.deleteConfirm', { name: server.name })}</Text>,
      labels: { confirm: t('web:common.delete'), cancel: t('web:common.cancel') },
      confirmProps: { color: 'red' },
      onConfirm: () => {
        remove.mutate(server.id, {
          onSuccess: () => {
            void navigate({ to: '/' });
          },
          onError: (error) => {
            notifications.show({ color: 'red', message: describeError(i18n, error) });
          },
        });
      },
    });
  };
  return (
    <form onSubmit={submit}>
      <Stack gap="sm" maw={480}>
        <TextInput label={t('web:server.settings.name')} {...form.getInputProps('name')} />
        <NumberInput
          label={t('web:server.settings.minRam')}
          min={256}
          step={256}
          {...form.getInputProps('minRamMb')}
        />
        <NumberInput
          label={t('web:server.settings.maxRam')}
          min={256}
          step={256}
          {...form.getInputProps('maxRamMb')}
        />
        <Switch
          label={t('web:server.settings.autoRestart')}
          {...form.getInputProps('autoRestart', { type: 'checkbox' })}
        />
        <Group justify="space-between" mt="sm">
          <Button
            type="button"
            variant="subtle"
            color="red"
            leftSection={<IconTrash size={16} />}
            onClick={confirmDelete}
          >
            {t('web:server.delete')}
          </Button>
          <Button type="submit" loading={update.isPending}>
            {t('web:common.save')}
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

export function ServerPage({ serverId, tab }: { serverId: string; tab: ServerTab }) {
  const { t } = useT();
  const navigate = useNavigate();
  const server = useServer(serverId);
  const me = useMe();
  const events = useEvents({ serverId, limit: 100 });
  const players = usePlayers(serverId, server.data?.server.runState === 'running');

  if (server.isPending) return <Loader />;
  if (server.error) return <ErrorAlert error={server.error} />;
  const s = server.data.server;
  const canSend = me.data !== undefined && hasRole(me.data.user.role, 'operator') && s.reachable;

  return (
    <Stack gap="md" data-testid="server-page" data-server-id={s.id}>
      <Group justify="space-between" align="flex-start" wrap="wrap">
        <Stack gap={2} style={{ minWidth: 0 }}>
          <Group gap="sm" wrap="nowrap">
            <Title order={2} style={{ wordBreak: 'break-word' }} data-testid="server-name">
              {s.name}
            </Title>
            <RunStateBadge server={s} size="lg" />
          </Group>
          <Text size="sm" c="dimmed">
            {serverSubtitle(s, t(`common:loader.${s.loader}`))}
            {s.gamePort === null ? '' : ` · :${String(s.gamePort)}`}
          </Text>
        </Stack>
        <ServerActions server={s} size="sm" />
      </Group>
      {!s.reachable && (
        <Alert color="orange" variant="light">
          {t('web:server.unreachable')}
        </Alert>
      )}
      <Tabs
        value={tab}
        onChange={(value) => {
          void navigate({
            to: '/servers/$serverId',
            params: { serverId },
            search: { tab: (value ?? 'overview') as ServerTab },
          });
        }}
        keepMounted={false}
      >
        <Tabs.List>
          {SERVER_TABS.map((name) => (
            <Tabs.Tab key={name} value={name} data-testid={`tab-${name}`}>
              {t(`web:server.tabs.${name}`)}
            </Tabs.Tab>
          ))}
        </Tabs.List>
        <Tabs.Panel value="overview" pt="md">
          <Overview server={s} />
        </Tabs.Panel>
        <Tabs.Panel value="console" pt="md">
          <Suspense fallback={<Loader size="sm" />}>
            <ConsolePanel
              serverId={s.id}
              canSend={canSend}
              loader={s.loader}
              players={players.data?.players.map((p) => p.name) ?? []}
            />
          </Suspense>
        </Tabs.Panel>
        <Tabs.Panel value="players" pt="md">
          <Players server={s} />
        </Tabs.Panel>
        <Tabs.Panel value="events" pt="md">
          {events.isPending ? (
            <Loader size="sm" />
          ) : (
            <EventsList events={events.data?.events ?? []} />
          )}
        </Tabs.Panel>
        <Tabs.Panel value="settings" pt="md">
          <Settings key={s.updatedAt} server={s} />
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
