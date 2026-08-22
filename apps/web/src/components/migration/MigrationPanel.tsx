/**
 * Phase 9 — migration d'un serveur vers une autre machine : modale (machine cible, répertoire surveillé
 * ou chemin explicite, relance, installation Java à la volée, message aux joueurs) avec **pré-checks**
 * affichés avant de lancer (dossier, port, Java, disque), puis carte de suivi (statut, progression,
 * mode direct/relais, historique). Rien n'est détruit côté source : le dossier est renommé.
 */
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Group,
  List,
  Modal,
  Progress,
  Select,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconArrowsExchange, IconCheck, IconX } from '@tabler/icons-react';
import { useState } from 'react';

import type { MigrationDto, MigrationPrecheckDto, ServerDto } from '@mmo/protocol/client';

import { useMigrationPrecheck, useMigrations, useStartMigration } from '../../api/phase9.js';
import { useMachines, useMe } from '../../api/queries.js';
import { useT } from '../../i18n/hooks.js';
import { tDynamic } from '../../i18n/index.js';
import { translateError } from '@mmo/shared';

import { describeError } from '../../lib/errors.js';
import { formatBytes, formatDateTime, hasRole } from '../../lib/format.js';
import { ErrorAlert } from '../ErrorAlert.js';

const ACTIVE = new Set<MigrationDto['status']>([
  'pending',
  'backing_up',
  'transferring',
  'restoring',
  'verifying',
]);

export function isActiveMigration(m: MigrationDto): boolean {
  return ACTIVE.has(m.status);
}

function useMigrationStatusLabel(): (status: MigrationDto['status']) => string {
  const { i18n } = useT();
  return (status) => tDynamic(i18n, `web:migration.status.${status}`);
}

function CheckItem({
  label,
  item,
  extra,
}: {
  label: string;
  item: { ok: boolean; code?: string | undefined };
  extra?: string | undefined;
}) {
  const { i18n } = useT();
  const reason =
    item.code === undefined
      ? undefined
      : i18n.exists(`web:migration.checks.${item.code}`)
        ? tDynamic(i18n, `web:migration.checks.${item.code}`)
        : item.code;
  return (
    <List.Item
      icon={item.ok ? <IconCheck size={16} color="teal" /> : <IconX size={16} color="red" />}
      data-testid={`check-${label}`}
      data-ok={item.ok}
    >
      <Text size="sm">
        {label}
        {extra === undefined ? '' : ` — ${extra}`}
        {reason === undefined ? '' : ` — ${reason}`}
      </Text>
    </List.Item>
  );
}

export function PrecheckList({ precheck }: { precheck: MigrationPrecheckDto }) {
  const { t } = useT();
  return (
    <List spacing={4} size="sm" data-testid="precheck-list">
      <CheckItem
        label={t('web:migration.checkPath')}
        item={precheck.path}
        extra={precheck.toPath}
      />
      <CheckItem label={t('web:migration.checkPort')} item={precheck.port} />
      <CheckItem
        label={t('web:migration.checkJava')}
        item={precheck.java}
        extra={
          precheck.java.runtime === undefined
            ? precheck.java.installable === true
              ? t('web:migration.javaInstallable')
              : undefined
            : `Java ${String(precheck.java.runtime.majorVersion)} (${precheck.java.runtime.vendor})`
        }
      />
      <CheckItem
        label={t('web:migration.checkDisk')}
        item={precheck.disk}
        extra={
          precheck.disk.freeBytes === undefined
            ? undefined
            : t('web:migration.diskFree', { free: formatBytes(precheck.disk.freeBytes) })
        }
      />
    </List>
  );
}

export function MigrationModal({
  server,
  opened,
  onClose,
}: {
  server: ServerDto;
  opened: boolean;
  onClose: () => void;
}) {
  const { t, i18n } = useT();
  const machines = useMachines();
  const precheck = useMigrationPrecheck(server.id);
  const start = useStartMigration(server.id);
  const [result, setResult] = useState<MigrationPrecheckDto | undefined>(undefined);
  const form = useForm({
    initialValues: {
      toMachineId: '',
      toDirectoryId: '',
      toPath: '',
      customPath: false,
      restartAfter: true,
      installJava: false,
      announce: '',
    },
    validate: {
      toMachineId: (v) => (v === '' ? t('web:errors.validation') : null),
      toPath: (v, values) =>
        values.customPath && v.trim() === '' ? t('web:errors.validation') : null,
    },
  });
  const targets = (machines.data?.machines ?? []).filter(
    (m) => m.id !== server.machineId && m.connected,
  );
  const target = targets.find((m) => m.id === form.values.toMachineId);
  const directories = target?.watchedDirectories ?? [];
  const input = () => ({
    toMachineId: form.values.toMachineId,
    ...(form.values.customPath
      ? { toPath: form.values.toPath.trim() }
      : form.values.toDirectoryId === ''
        ? {}
        : { toDirectoryId: form.values.toDirectoryId }),
  });
  const fail = (error: unknown): void => {
    notifications.show({ color: 'red', message: describeError(i18n, error) });
  };
  const close = (): void => {
    setResult(undefined);
    form.reset();
    precheck.reset();
    start.reset();
    onClose();
  };
  const canStart =
    result !== undefined &&
    result.path.ok &&
    result.port.ok &&
    result.disk.ok &&
    (result.java.ok || (form.values.installJava && result.java.installable === true));

  return (
    <Modal opened={opened} onClose={close} title={t('web:migration.title')} size="lg">
      <form
        onSubmit={form.onSubmit(() => {
          start.mutate(
            {
              ...input(),
              restartAfter: form.values.restartAfter,
              installJava: form.values.installJava,
              ...(form.values.announce.trim() === ''
                ? {}
                : { announce: form.values.announce.trim() }),
            },
            {
              onSuccess: () => {
                notifications.show({ color: 'teal', message: t('web:migration.started') });
                close();
              },
              onError: fail,
            },
          );
        })}
      >
        <Stack gap="sm">
          <Text size="sm" c="dimmed">
            {t('web:migration.hint')}
          </Text>
          {targets.length === 0 && <Alert color="yellow">{t('web:migration.noTarget')}</Alert>}
          <Select
            label={t('web:migration.targetMachine')}
            data={targets.map((m) => ({ value: m.id, label: m.name }))}
            required
            data-testid="migration-target"
            {...form.getInputProps('toMachineId')}
            onChange={(v) => {
              form.setFieldValue('toMachineId', v ?? '');
              form.setFieldValue('toDirectoryId', '');
              setResult(undefined);
            }}
          />
          <Switch
            label={t('web:migration.customPath')}
            checked={form.values.customPath}
            onChange={(e) => {
              form.setFieldValue('customPath', e.currentTarget.checked);
              setResult(undefined);
            }}
          />
          {form.values.customPath ? (
            <TextInput
              label={t('web:migration.targetPath')}
              placeholder={t('web:machine.directoryPlaceholder')}
              data-testid="migration-path"
              {...form.getInputProps('toPath')}
            />
          ) : (
            <Select
              label={t('web:migration.targetDirectory')}
              description={t('web:migration.targetDirectoryHint')}
              data={directories.map((d) => ({ value: d.id, label: d.path }))}
              disabled={target === undefined}
              placeholder={directories[0]?.path}
              data-testid="migration-directory"
              value={form.values.toDirectoryId === '' ? null : form.values.toDirectoryId}
              onChange={(v) => {
                form.setFieldValue('toDirectoryId', v ?? '');
                setResult(undefined);
              }}
            />
          )}
          <Group gap="md">
            <Checkbox
              label={t('web:migration.restartAfter')}
              {...form.getInputProps('restartAfter', { type: 'checkbox' })}
            />
            <Checkbox
              label={t('web:migration.installJava')}
              {...form.getInputProps('installJava', { type: 'checkbox' })}
            />
          </Group>
          <TextInput
            label={t('web:migration.announce')}
            placeholder={t('web:migration.announcePlaceholder')}
            {...form.getInputProps('announce')}
          />
          <Group gap="xs">
            <Button
              type="button"
              variant="light"
              loading={precheck.isPending}
              disabled={form.values.toMachineId === ''}
              data-testid="migration-precheck"
              onClick={() => {
                if (form.validate().hasErrors) return;
                precheck.mutate(input(), {
                  onSuccess: (data) => {
                    setResult(data.precheck);
                  },
                  onError: fail,
                });
              }}
            >
              {t('web:migration.precheck')}
            </Button>
          </Group>
          {result !== undefined && <PrecheckList precheck={result} />}
          <ErrorAlert error={start.error} />
          <Group justify="flex-end">
            <Button type="button" variant="subtle" onClick={close}>
              {t('web:common.cancel')}
            </Button>
            <Button
              type="submit"
              loading={start.isPending}
              disabled={!canStart}
              leftSection={<IconArrowsExchange size={14} />}
              data-testid="migration-start"
            >
              {t('web:migration.start')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

/** Carte de suivi : migration active (barre) + historique. */
export function MigrationsCard({ server }: { server: ServerDto }) {
  const { t, i18n } = useT();
  const me = useMe();
  const machines = useMachines();
  const migrations = useMigrations(server.id);
  const statusLabel = useMigrationStatusLabel();
  const [open, setOpen] = useState(false);
  const isAdmin = me.data !== undefined && hasRole(me.data.user.role, 'admin');
  const rows = migrations.data?.migrations ?? [];
  const active = rows.find(isActiveMigration);
  const machineName = (id: string): string =>
    machines.data?.machines.find((m) => m.id === id)?.name ?? id;
  return (
    <Card withBorder radius="md" padding="md" data-testid="migrations-card">
      <Stack gap="sm">
        <Group justify="space-between">
          <Title order={5}>{t('web:migration.title')}</Title>
          {isAdmin && (
            <Button
              type="button"
              size="xs"
              variant="light"
              leftSection={<IconArrowsExchange size={14} />}
              disabled={active !== undefined || server.provisioning !== 'ready'}
              onClick={() => {
                setOpen(true);
              }}
              data-testid="migration-open"
            >
              {t('web:migration.migrate')}
            </Button>
          )}
        </Group>
        {active !== undefined && (
          <Stack gap={4} data-testid="migration-active" data-status={active.status}>
            <Group justify="space-between">
              <Text size="sm">
                {machineName(active.fromMachineId)} → {machineName(active.toMachineId)}
              </Text>
              <Badge variant="light">{statusLabel(active.status)}</Badge>
            </Group>
            <Progress value={active.progressPct ?? 0} animated size="sm" />
            <Text size="xs" c="dimmed">
              {active.toPath}
              {active.mode === null
                ? ''
                : ` · ${t(`web:migration.mode.${active.mode === 'relay' ? 'relay' : 'direct'}`)}`}
            </Text>
          </Stack>
        )}
        {rows.length === 0 ? (
          <Text size="sm" c="dimmed">
            {t('web:migration.none')}
          </Text>
        ) : (
          <Table striped withTableBorder>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('web:common.date')}</Table.Th>
                <Table.Th>{t('web:migration.route')}</Table.Th>
                <Table.Th>{t('web:common.status')}</Table.Th>
                <Table.Th>{t('web:migration.modeLabel')}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((m) => (
                <Table.Tr key={m.id} data-testid={`migration-${m.id}`} data-status={m.status}>
                  <Table.Td>{formatDateTime(m.startedAt, i18n.language)}</Table.Td>
                  <Table.Td>
                    {machineName(m.fromMachineId)} → {machineName(m.toMachineId)}
                  </Table.Td>
                  <Table.Td>
                    <Badge
                      variant="light"
                      color={m.status === 'done' ? 'teal' : m.status === 'failed' ? 'red' : 'blue'}
                    >
                      {statusLabel(m.status)}
                    </Badge>
                    {m.error !== null && (
                      <Text size="xs" c="red">
                        {translateError(i18n, { code: m.error.code, details: m.error.details })}
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td>
                    {m.mode === null
                      ? '—'
                      : t(`web:migration.mode.${m.mode === 'relay' ? 'relay' : 'direct'}`)}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
      </Stack>
      <MigrationModal
        server={server}
        opened={open}
        onClose={() => {
          setOpen(false);
        }}
      />
    </Card>
  );
}
