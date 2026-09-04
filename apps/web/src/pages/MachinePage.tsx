/** Page machine : statut/heartbeat, répertoires surveillés, scan, ajout de dossier serveur, codes, secret, suppression. */
import {
  ActionIcon,
  Button,
  Card,
  Group,
  Loader,
  Modal,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { IconFolderPlus, IconKey, IconPlus, IconRadar, IconTrash } from '@tabler/icons-react';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useT } from '../i18n/hooks.js';

import type { PairingCodeDto } from '@mmo/protocol/client';

import {
  useAddDirectory,
  useConflicts,
  useCreateServer,
  useDeleteMachine,
  useMachine,
  useMe,
  useNewPairingCode,
  useRemoveDirectory,
  useRotateSecret,
  useScan,
  useServers,
  useUpdateMachine,
  type ScanResult,
} from '../api/queries.js';
import { useAccessStatus } from '../api/phase10.js';
import { ConflictsPanel } from '../components/ConflictsPanel.js';
import { ErrorAlert } from '../components/ErrorAlert.js';
import { MachineHeader } from '../components/MachineHeader.js';
import { MachineHostsCard } from '../components/access/MachineHostsCard.js';
import { AgentCard } from '../components/machine/AgentCard.js';
import { JavaCard } from '../components/machine/JavaCard.js';
import { MachineMetricsPanel } from '../components/metrics/MetricsPanel.js';
import { PairingCodeCard } from '../components/PairingCodeCard.js';
import { ServerCard } from '../components/ServerCard.js';
import { describeError } from '../lib/errors.js';
import { formatDateTime, hasRole } from '../lib/format.js';
import { CreateServerModal } from '../components/machine/CreateServerModal.js';
import { canMachine } from '../lib/permissions.js';
import { useNow } from '../lib/hooks.js';
import { TECHNICAL_INPUT_PROPS } from '../lib/inputs.js';

export function MachinePage({ machineId }: { machineId: string }) {
  const { t, i18n } = useT();
  const navigate = useNavigate();
  const me = useMe();
  const machine = useMachine(machineId);
  const servers = useServers();
  const conflicts = useConflicts();
  const now = useNow(10_000);
  const addDir = useAddDirectory(machineId);
  const removeDir = useRemoveDirectory(machineId);
  const scan = useScan(machineId);
  const addServer = useCreateServer();
  const newCode = useNewPairingCode(machineId);
  const rotate = useRotateSecret(machineId);
  const update = useUpdateMachine(machineId);
  const remove = useDeleteMachine();
  const [pairing, setPairing] = useState<PairingCodeDto | undefined>(undefined);
  const [scanResult, setScanResult] = useState<ScanResult | undefined>(undefined);
  const [addServerOpen, setAddServerOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const dirForm = useForm({
    initialValues: { path: '' },
    validate: { path: (v) => (v.trim() === '' ? t('web:errors.validation') : null) },
  });
  const serverForm = useForm({
    initialValues: { path: '', name: '' },
    validate: { path: (v) => (v.trim() === '' ? t('web:errors.validation') : null) },
  });
  const isAdmin = me.data !== undefined && hasRole(me.data.user.role, 'admin');
  // Lot 2 : voie d'accès de la machine — le choix se présente au moment de générer un code.
  // Avant les early returns : c'est un hook.
  const access = useAccessStatus(isAdmin);

  if (machine.isPending) return <Loader />;
  if (machine.error) return <ErrorAlert error={machine.error} />;
  const m = machine.data.machine;
  const canOperate = canMachine(me.data, m.id, 'operator');
  // Lot 5 : creer un serveur = operateur sur la MACHINE (le chemin, lui, reste borne aux
  // repertoires surveilles) — c est la regle tranchee avec le 8e chantier du lot 8.
  const canCreate = canOperate;
  const mine = servers.data?.servers.filter((s) => s.machineId === m.id) ?? [];
  const myConflicts = conflicts.data?.conflicts.filter((c) => c.found.machineId === m.id) ?? [];
  const fail = (error: unknown): void => {
    notifications.show({ color: 'red', message: describeError(i18n, error) });
  };

  const runScan = (): void => {
    scan.mutate(undefined, {
      onSuccess: (result) => {
        setScanResult(result);
        notifications.show({
          color: 'teal',
          message: t('web:machine.scanResult', {
            count: result.servers.length,
            paths: result.scannedPaths.length,
          }),
        });
        if (result.conflicts.length > 0) {
          notifications.show({
            color: 'orange',
            message: t('web:machine.scanConflicts', { count: result.conflicts.length }),
          });
        }
      },
      onError: fail,
    });
  };

  const confirmRemove = (): void => {
    modals.openConfirmModal({
      title: t('web:machine.remove'),
      children: <Text size="sm">{t('web:machine.removeConfirm', { name: m.name })}</Text>,
      labels: { confirm: t('web:common.delete'), cancel: t('web:common.cancel') },
      confirmProps: { color: 'red' },
      onConfirm: () => {
        remove.mutate(m.id, {
          onSuccess: () => {
            void navigate({ to: '/machines' });
          },
          onError: fail,
        });
      },
    });
  };

  const confirmRemoveDir = (dirId: string, path: string): void => {
    modals.openConfirmModal({
      title: t('web:machine.directories'),
      children: <Text size="sm">{t('web:machine.removeDirectoryConfirm', { path })}</Text>,
      labels: { confirm: t('web:common.delete'), cancel: t('web:common.cancel') },
      confirmProps: { color: 'red' },
      onConfirm: () => {
        removeDir.mutate(dirId, { onError: fail });
      },
    });
  };

  return (
    <Stack gap="lg" data-testid="machine-page" data-machine-id={m.id}>
      <Card withBorder radius="md" padding="md">
        <Stack gap="sm">
          <MachineHeader machine={m} now={now} link={false} />
          <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="xs">
            <Text size="xs" c="dimmed">
              {t('web:machine.hostname')} : {m.hostname ?? '—'}
            </Text>
            <Text size="xs" c="dimmed">
              {t('web:machine.os')} : {m.os ?? '—'} {m.arch ?? ''}
            </Text>
            <Text size="xs" c="dimmed">
              {t('web:machine.agent')} : {m.agentVersion ?? '—'} · {t('web:machine.protocol')}{' '}
              {m.protocolVersion ?? '—'}
            </Text>
            <Text size="xs" c="dimmed">
              {t('web:machine.lastSeen')} : {formatDateTime(m.lastSeenAt, i18n.language)}
            </Text>
          </SimpleGrid>
          {isAdmin && (
            <Group gap="xs" wrap="wrap">
              <Button
                size="xs"
                variant="light"
                leftSection={<IconKey size={14} />}
                onClick={() => {
                  newCode.mutate(undefined, {
                    onSuccess: (data) => {
                      setPairing(data.pairing);
                    },
                    onError: fail,
                  });
                }}
                loading={newCode.isPending}
                data-testid="new-code"
              >
                {t('web:machine.newCode')}
              </Button>
              <Button
                size="xs"
                variant="light"
                onClick={() => {
                  rotate.mutate(undefined, {
                    onSuccess: () => {
                      notifications.show({ color: 'teal', message: t('web:machine.rotated') });
                    },
                    onError: fail,
                  });
                }}
                loading={rotate.isPending}
                disabled={!m.connected}
              >
                {t('web:machine.rotateSecret')}
              </Button>
              <Button
                size="xs"
                variant="subtle"
                color="gray"
                onClick={() => {
                  update.mutate({ disabled: m.status !== 'disabled' }, { onError: fail });
                }}
                loading={update.isPending}
              >
                {m.status === 'disabled' ? t('web:machine.enable') : t('web:machine.disable')}
              </Button>
              <Button
                size="xs"
                variant="subtle"
                color="red"
                leftSection={<IconTrash size={14} />}
                onClick={confirmRemove}
              >
                {t('web:machine.remove')}
              </Button>
            </Group>
          )}
        </Stack>
      </Card>

      {myConflicts.length > 0 && <ConflictsPanel conflicts={myConflicts} />}

      <AgentCard machine={m} />
      <MachineHostsCard machine={m} />

      <Card withBorder radius="md" padding="md">
        <Stack gap="sm">
          <Title order={2} size="h4">
            {t('web:metrics.title')}
          </Title>
          <MachineMetricsPanel machine={m} />
        </Stack>
      </Card>

      <Card withBorder radius="md" padding="md">
        <Stack gap="sm">
          <Group justify="space-between">
            <Title order={2} size="h4">
              {t('web:machine.directories')}
            </Title>
            {canOperate && (
              <Button
                size="xs"
                leftSection={<IconRadar size={14} />}
                onClick={runScan}
                loading={scan.isPending}
                disabled={!m.connected}
                data-testid="scan"
              >
                {scan.isPending ? t('web:machine.scanning') : t('web:machine.scan')}
              </Button>
            )}
          </Group>
          {m.watchedDirectories.length === 0 ? (
            <Text size="sm" c="dimmed">
              {t('web:machine.noDirectories')}
            </Text>
          ) : (
            <Table striped withTableBorder data-testid="directories">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('web:common.path')}</Table.Th>
                  <Table.Th>{t('web:machine.lastScan')}</Table.Th>
                  {isAdmin && <Table.Th w={60} />}
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {m.watchedDirectories.map((d) => (
                  <Table.Tr key={d.id}>
                    <Table.Td>
                      <Text size="sm" ff="monospace" style={{ wordBreak: 'break-all' }}>
                        {d.path}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      {d.lastScanAt === null
                        ? t('web:common.never')
                        : formatDateTime(d.lastScanAt, i18n.language)}
                    </Table.Td>
                    {isAdmin && (
                      <Table.Td>
                        <Tooltip label={t('web:common.delete')} withArrow>
                          <ActionIcon
                            variant="subtle"
                            color="red"
                            onClick={() => {
                              confirmRemoveDir(d.id, d.path);
                            }}
                            aria-label={t('web:common.delete')}
                          >
                            <IconTrash size={16} />
                          </ActionIcon>
                        </Tooltip>
                      </Table.Td>
                    )}
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          )}
          {isAdmin && (
            <form
              onSubmit={dirForm.onSubmit((values) => {
                addDir.mutate(
                  { path: values.path.trim() },
                  {
                    onSuccess: () => {
                      dirForm.reset();
                    },
                    onError: fail,
                  },
                );
              })}
            >
              <Group align="flex-end" gap="xs" wrap="nowrap">
                <TextInput
                  label={t('web:machine.directoryPath')}
                  placeholder={t('web:machine.directoryPlaceholder')}
                  style={{ flex: 1 }}
                  {...TECHNICAL_INPUT_PROPS}
                  data-testid="directory-path"
                  {...dirForm.getInputProps('path')}
                />
                <Button type="submit" loading={addDir.isPending} data-testid="directory-add">
                  {t('web:common.add')}
                </Button>
              </Group>
            </form>
          )}
          {scanResult !== undefined && (
            <Text size="xs" c="dimmed" data-testid="scan-result">
              {t('web:machine.scanResult', {
                count: scanResult.servers.length,
                paths: scanResult.scannedPaths.length,
              })}
            </Text>
          )}
        </Stack>
      </Card>

      <Card withBorder radius="md" padding="md">
        <Stack gap="sm">
          <Group justify="space-between">
            <Title order={2} size="h4">
              {t('web:machine.servers')}
            </Title>
            <Group gap="xs">
              {canCreate && (
                <Button
                  size="xs"
                  leftSection={<IconPlus size={14} />}
                  onClick={() => {
                    setCreateOpen(true);
                  }}
                  disabled={!m.connected || m.watchedDirectories.length === 0}
                  data-testid="create-server"
                >
                  {t('web:install.title')}
                </Button>
              )}
              {isAdmin && (
                <Button
                  size="xs"
                  variant="light"
                  leftSection={<IconFolderPlus size={14} />}
                  onClick={() => {
                    setAddServerOpen(true);
                  }}
                  disabled={!m.connected}
                  data-testid="add-server"
                >
                  {t('web:machine.addServer')}
                </Button>
              )}
            </Group>
          </Group>
          {mine.length === 0 ? (
            <Text size="sm" c="dimmed">
              {t('web:dashboard.noServers')}
            </Text>
          ) : (
            <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="sm">
              {mine.map((server) => (
                <ServerCard key={server.id} server={server} />
              ))}
            </SimpleGrid>
          )}
        </Stack>
      </Card>

      <JavaCard machine={m} />

      <Modal
        opened={pairing !== undefined}
        onClose={() => {
          setPairing(undefined);
        }}
        title={t('web:machine.pairing.title')}
        size="lg"
      >
        {pairing !== undefined && (
          <Stack gap="md">
            {(() => {
              // Voie d'accès de CETTE machine (lot 2) : proposé seulement quand il y a un choix —
              // une URL directe configurée en plus de l'URL publique. Changer la voie régénère le
              // code : les one-liners affichés sont calculés côté panel à la création du code.
              const a = access.data?.access;
              const defaultUrl = a?.publicUrl ?? null;
              const directUrl = a?.directUrl ?? null;
              const current = m.panelUrl ?? '';
              const choices = [
                {
                  value: '',
                  label: t('web:machine.pairing.routeDefault', { url: defaultUrl ?? '—' }),
                },
                ...(directUrl !== null && directUrl !== defaultUrl
                  ? [
                      {
                        value: directUrl,
                        label: t('web:machine.pairing.routeDirect', { url: directUrl }),
                      },
                    ]
                  : []),
                ...(current !== '' && current !== directUrl
                  ? [{ value: current, label: current }]
                  : []),
              ];
              if (choices.length < 2) return null;
              return (
                <Select
                  label={t('web:machine.pairing.route')}
                  description={t('web:machine.pairing.routeHint')}
                  value={current}
                  allowDeselect={false}
                  data={choices}
                  onChange={(value) => {
                    if (value === null || value === current) return;
                    update.mutate(
                      { panelUrl: value === '' ? null : value },
                      {
                        onSuccess: () => {
                          newCode.mutate(undefined, {
                            onSuccess: (data) => {
                              setPairing(data.pairing);
                            },
                            onError: fail,
                          });
                        },
                        onError: fail,
                      },
                    );
                  }}
                  data-testid="pairing-route"
                />
              );
            })()}
            <PairingCodeCard pairing={pairing} />
          </Stack>
        )}
      </Modal>

      <CreateServerModal
        machine={m}
        directories={m.watchedDirectories}
        opened={createOpen}
        onClose={() => {
          setCreateOpen(false);
        }}
        onCreated={(serverId) => {
          void navigate({
            to: '/servers/$serverId',
            params: { serverId },
            search: { tab: 'overview' },
          });
        }}
      />

      <Modal
        opened={addServerOpen}
        onClose={() => {
          setAddServerOpen(false);
          serverForm.reset();
          addServer.reset();
        }}
        title={t('web:machine.addServer')}
      >
        <form
          onSubmit={serverForm.onSubmit((values) => {
            addServer.mutate(
              {
                machineId: m.id,
                path: values.path.trim(),
                ...(values.name.trim() === '' ? {} : { name: values.name.trim() }),
              },
              {
                onSuccess: (data) => {
                  setAddServerOpen(false);
                  serverForm.reset();
                  void navigate({
                    to: '/servers/$serverId',
                    params: { serverId: data.server.id },
                    search: { tab: 'overview' },
                  });
                },
              },
            );
          })}
        >
          <Stack gap="sm">
            <Text size="sm" c="dimmed">
              {t('web:machine.addServerHint')}
            </Text>
            <TextInput
              label={t('web:machine.directoryPath')}
              placeholder={t('web:machine.directoryPlaceholder')}
              required
              {...TECHNICAL_INPUT_PROPS}
              data-testid="server-path"
              {...serverForm.getInputProps('path')}
            />
            <TextInput label={t('web:common.name')} {...serverForm.getInputProps('name')} />
            <ErrorAlert error={addServer.error} />
            <Group justify="flex-end">
              <Button type="submit" loading={addServer.isPending} data-testid="server-add-submit">
                {t('web:common.add')}
              </Button>
            </Group>
          </Stack>
        </form>
      </Modal>
    </Stack>
  );
}
