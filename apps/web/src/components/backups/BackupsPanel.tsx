/**
 * Onglet Sauvegardes (phase 8) : archives présentes (taille, date, genre, à chaud, sha256),
 * création (task avec progression), restauration en un clic (backup de sécurité par défaut,
 * relance optionnelle), téléchargement (lien direct), suppression ; politiques de backups planifiés
 * (cron + rotation) poussées à l'agent et exécutées par lui, panel éteint ou non.
 */
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Group,
  Loader,
  Menu,
  NumberInput,
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
  IconCalendarClock,
  IconDotsVertical,
  IconDownload,
  IconPlus,
  IconRestore,
  IconTrash,
} from '@tabler/icons-react';
import { useState } from 'react';

import type { BackupDto, BackupPolicyDto, ServerDto } from '@mmo/protocol/client';

import {
  backupDownloadUrl,
  useBackupPolicyMutations,
  useBackups,
  useCreateBackup,
  useDeleteBackup,
  useRestoreBackup,
  useServerTasks,
} from '../../api/phase8.js';
import { useMe } from '../../api/queries.js';
import { useT } from '../../i18n/hooks.js';
import { describeError } from '../../lib/errors.js';
import { formatBytes, formatDateTime, hasRole } from '../../lib/format.js';
import { ErrorAlert } from '../ErrorAlert.js';
import { HelpLink } from '../HelpLink.js';
import { ScheduleInput, describeWhen, isScheduleValid } from '../schedule/ScheduleInput.js';
import { TaskProgressRow, isActiveTask } from '../tasks/TaskProgress.js';

function kindColor(kind: BackupDto['kind']): string {
  switch (kind) {
    case 'manual':
      return 'blue';
    case 'scheduled':
      return 'teal';
    case 'pre_restore':
      return 'orange';
    case 'pre_migration':
      return 'grape';
  }
}

function statusColor(status: BackupDto['status']): string {
  switch (status) {
    case 'success':
      return 'green';
    case 'running':
      return 'blue';
    case 'failed':
      return 'red';
    case 'deleted':
      return 'gray';
  }
}

export function BackupsPanel({ server }: { server: ServerDto }) {
  const { t, i18n } = useT();
  const me = useMe();
  const q = useBackups(server.id);
  const tasks = useServerTasks(server.id);
  const create = useCreateBackup(server.id);
  const restore = useRestoreBackup(server.id);
  const remove = useDeleteBackup(server.id);
  const canAct =
    me.data !== undefined && hasRole(me.data.user.role, 'operator') && server.reachable;
  const fail = (error: unknown) => {
    notifications.show({ color: 'red', message: describeError(i18n, error) });
  };
  const activeTasks = (tasks.data?.tasks ?? []).filter(
    (task) =>
      isActiveTask(task) && (task.kind === 'backup.create' || task.kind === 'backup.restore'),
  );
  const busy = activeTasks.length > 0;

  const askCreate = () => {
    let comment = '';
    const id = modals.open({
      title: t('web:backups.create'),
      children: (
        <Stack gap="sm">
          <Text size="sm">
            {server.runState === 'running' ? t('web:backups.hotHint') : t('web:backups.coldHint')}
          </Text>
          <TextInput
            label={t('web:backups.comment')}
            maxLength={500}
            onChange={(e) => {
              comment = e.currentTarget.value;
            }}
            data-testid="backup-comment"
          />
          <Group justify="flex-end">
            <Button
              type="button"
              variant="default"
              onClick={() => {
                modals.close(id);
              }}
            >
              {t('web:common.cancel')}
            </Button>
            <Button
              type="button"
              data-testid="backup-create-confirm"
              onClick={() => {
                modals.close(id);
                create.mutate(comment === '' ? {} : { comment }, {
                  onError: fail,
                  onSuccess: () => {
                    notifications.show({ message: t('web:backups.started') });
                  },
                });
              }}
            >
              {t('web:backups.create')}
            </Button>
          </Group>
        </Stack>
      ),
    });
  };

  const askRestore = (backup: BackupDto) => {
    let safetyBackup = true;
    let restartAfter = server.runState === 'running';
    const id = modals.open({
      title: t('web:backups.restore'),
      children: (
        <Stack gap="sm">
          <Text size="sm">
            {t('web:backups.restoreConfirm', {
              date: formatDateTime(backup.finishedAt ?? backup.startedAt, i18n.language),
            })}
          </Text>
          {server.runState === 'running' && (
            <Text size="sm" className="mmo-warn-text">
              {t('web:backups.restoreStops')}
            </Text>
          )}
          <Checkbox
            defaultChecked
            label={t('web:backups.safetyBackup')}
            description={t('web:backups.safetyBackupHint')}
            onChange={(e) => {
              safetyBackup = e.currentTarget.checked;
            }}
            data-testid="restore-safety"
          />
          <Checkbox
            defaultChecked={restartAfter}
            label={t('web:backups.restartAfter')}
            onChange={(e) => {
              restartAfter = e.currentTarget.checked;
            }}
            data-testid="restore-restart"
          />
          <Group justify="flex-end">
            <Button
              type="button"
              variant="default"
              onClick={() => {
                modals.close(id);
              }}
            >
              {t('web:common.cancel')}
            </Button>
            <Button
              type="button"
              color="orange"
              data-testid="restore-confirm"
              onClick={() => {
                modals.close(id);
                restore.mutate(
                  { backupId: backup.id, safetyBackup, restartAfter },
                  {
                    onError: fail,
                    onSuccess: () => {
                      notifications.show({ message: t('web:backups.restoreStarted') });
                    },
                  },
                );
              }}
            >
              {t('web:backups.restore')}
            </Button>
          </Group>
        </Stack>
      ),
    });
  };

  const askDelete = (backup: BackupDto) => {
    modals.openConfirmModal({
      title: t('web:backups.delete'),
      children: <Text size="sm">{t('web:backups.deleteConfirm')}</Text>,
      labels: { confirm: t('web:common.delete'), cancel: t('web:common.cancel') },
      confirmProps: { color: 'red', 'data-testid': 'backup-delete-confirm' } as never,
      onConfirm: () => {
        remove.mutate(backup.id, { onError: fail });
      },
    });
  };

  const backups = q.data?.backups ?? [];

  return (
    <Stack gap="md" data-testid="backups-panel">
      {q.error !== null && <ErrorAlert error={q.error} />}
      <Card withBorder padding="md">
        <Group justify="space-between" mb="sm" wrap="wrap">
          <Stack gap={0}>
            <Group gap={6}>
              <Text fw={600}>{t('web:backups.title')}</Text>
              <HelpLink topic="backups" />
            </Group>
            <Text size="xs" c="dimmed">
              {t('web:backups.hint')}
            </Text>
          </Stack>
          {canAct && (
            <Button
              type="button"
              size="xs"
              leftSection={<IconPlus size={14} />}
              onClick={askCreate}
              disabled={busy || create.isPending}
              data-testid="backup-create"
            >
              {t('web:backups.create')}
            </Button>
          )}
        </Group>
        {activeTasks.length > 0 && (
          <Stack gap="xs" mb="sm" data-testid="backup-tasks">
            {activeTasks.map((task) => (
              <TaskProgressRow key={task.id} task={task} />
            ))}
          </Stack>
        )}
        {q.isPending && <Loader size="sm" />}
        {q.data !== undefined && backups.length === 0 && (
          <Text size="sm" c="dimmed" data-testid="backups-empty">
            {t('web:backups.empty')}
          </Text>
        )}
        {backups.length > 0 && (
          <Table.ScrollContainer minWidth={600}>
            <Table highlightOnHover data-testid="backups-table">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('web:backups.date')}</Table.Th>
                  <Table.Th>{t('web:backups.kind')}</Table.Th>
                  <Table.Th>{t('web:backups.size')}</Table.Th>
                  <Table.Th>{t('web:backups.status')}</Table.Th>
                  <Table.Th>{t('web:backups.comment')}</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {backups.map((b) => (
                  <Table.Tr key={b.id} data-testid={`backup-${b.id}`} data-status={b.status}>
                    <Table.Td>
                      <Text size="sm">
                        {formatDateTime(b.finishedAt ?? b.startedAt, i18n.language)}
                      </Text>
                      {b.hot === true && (
                        <Text size="xs" c="dimmed">
                          {t('web:backups.hot')}
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <Badge size="sm" variant="light" color={kindColor(b.kind)}>
                        {t(`web:backups.kinds.${b.kind}`)}
                      </Badge>
                    </Table.Td>
                    <Table.Td>
                      {b.sizeBytes === null ? '—' : formatBytes(b.sizeBytes)}
                      {b.files !== null && (
                        <Text size="xs" c="dimmed">
                          {t('web:backups.files', { count: b.files })}
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <Tooltip
                        label={b.sha256 ?? b.error ?? ''}
                        disabled={b.sha256 === null && b.error === null}
                      >
                        <Badge size="sm" variant="dot" color={statusColor(b.status)}>
                          {t(`web:backups.statuses.${b.status}`)}
                        </Badge>
                      </Tooltip>
                      {b.status === 'success' && b.verifyStatus === 'corrupted' && (
                        <Tooltip label={t('web:backups.corruptedHint')} multiline maw={320}>
                          <Badge
                            size="sm"
                            color="red"
                            ml={6}
                            data-testid={`backup-corrupted-${b.id}`}
                          >
                            {t('web:backups.corrupted')}
                          </Badge>
                        </Tooltip>
                      )}
                      {b.status === 'success' && b.verifyStatus !== 'corrupted' && (
                        <Text size="xs" c="dimmed" data-testid={`backup-verified-${b.id}`}>
                          {b.verifiedAt === null
                            ? t('web:backups.notVerified')
                            : t('web:backups.verified', {
                                date: formatDateTime(b.verifiedAt, i18n.language),
                              })}
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" c="dimmed" truncate maw={220}>
                        {b.comment ?? ''}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      {b.status === 'success' && (
                        <Menu position="bottom-end" withinPortal>
                          <Menu.Target>
                            <Button
                              type="button"
                              variant="subtle"
                              size="compact-sm"
                              aria-label={t('web:common.actions')}
                              data-testid={`backup-actions-${b.id}`}
                            >
                              <IconDotsVertical size={16} />
                            </Button>
                          </Menu.Target>
                          <Menu.Dropdown>
                            <Menu.Item
                              component="a"
                              href={backupDownloadUrl(server.id, b.id)}
                              download
                              leftSection={<IconDownload size={14} />}
                            >
                              {t('web:backups.download')}
                            </Menu.Item>
                            {canAct && (
                              <>
                                <Menu.Item
                                  leftSection={<IconRestore size={14} />}
                                  disabled={busy}
                                  onClick={() => {
                                    askRestore(b);
                                  }}
                                  data-testid={`backup-restore-${b.id}`}
                                >
                                  {t('web:backups.restore')}
                                </Menu.Item>
                                <Menu.Divider />
                                <Menu.Item
                                  color="red"
                                  leftSection={<IconTrash size={14} />}
                                  onClick={() => {
                                    askDelete(b);
                                  }}
                                  data-testid={`backup-delete-${b.id}`}
                                >
                                  {t('web:backups.delete')}
                                </Menu.Item>
                              </>
                            )}
                          </Menu.Dropdown>
                        </Menu>
                      )}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </Card>
      <PoliciesCard server={server} policies={q.data?.policies ?? []} canAct={canAct} />
    </Stack>
  );
}

// --- Politiques (plannings agent) ----------------------------------------------------------------

/**
 * État réel de la politique. Sans lui, une politique morte s'affiche exactement comme une
 * politique saine : seule la « prochaine exécution » était montrée, et elle est recalculée à
 * chaque affichage, donc toujours rassurante.
 */
function PolicyHealth({ policy }: { policy: BackupPolicyDto }) {
  const { t } = useT();
  if (policy.overdueSince !== null) {
    return (
      <Badge size="xs" color="red" data-testid={`policy-health-${policy.id}`}>
        {t('web:backups.health.overdue')}
      </Badge>
    );
  }
  if (policy.lastStatus === null) return null;
  const color =
    policy.lastStatus === 'success' ? 'teal' : policy.lastStatus === 'failed' ? 'red' : 'gray';
  return (
    <Badge
      size="xs"
      color={color}
      data-testid={`policy-health-${policy.id}`}
      title={policy.lastError ?? undefined}
    >
      {t(`web:backups.health.${policy.lastStatus}`)}
    </Badge>
  );
}

function PoliciesCard({
  server,
  policies,
  canAct,
}: {
  server: ServerDto;
  policies: BackupPolicyDto[];
  canAct: boolean;
}) {
  const { t, i18n } = useT();
  const m = useBackupPolicyMutations(server.id);
  const [editing, setEditing] = useState<BackupPolicyDto | 'new' | undefined>(undefined);
  const fail = (error: unknown) => {
    notifications.show({ color: 'red', message: describeError(i18n, error) });
  };
  return (
    <Card withBorder padding="md" data-testid="backup-policies">
      <Group justify="space-between" mb="sm" wrap="wrap">
        <Stack gap={0}>
          <Text fw={600}>{t('web:backups.policies')}</Text>
          <Text size="xs" c="dimmed">
            {t('web:backups.policiesHint')}
          </Text>
        </Stack>
        {canAct && editing === undefined && (
          <Button
            type="button"
            size="xs"
            variant="light"
            leftSection={<IconCalendarClock size={14} />}
            onClick={() => {
              setEditing('new');
            }}
            data-testid="policy-new"
          >
            {t('web:backups.addPolicy')}
          </Button>
        )}
      </Group>
      {policies.length === 0 && editing === undefined && (
        <Text size="sm" c="dimmed">
          {t('web:backups.noPolicy')}
        </Text>
      )}
      <Stack gap="xs">
        {policies.map((p) =>
          editing !== undefined && editing !== 'new' && editing.id === p.id ? (
            <PolicyForm
              key={p.id}
              initial={p}
              onCancel={() => {
                setEditing(undefined);
              }}
              onSubmit={(input) => {
                m.update.mutate(
                  { policyId: p.id, ...input },
                  {
                    onError: fail,
                    onSuccess: () => {
                      setEditing(undefined);
                    },
                  },
                );
              }}
            />
          ) : (
            <Group key={p.id} justify="space-between" wrap="wrap" data-testid={`policy-${p.id}`}>
              <Stack gap={0}>
                <Group gap="xs">
                  <Text size="sm" fw={600}>
                    {describeWhen(
                      p.cron,
                      null,
                      i18n.t as (k: string, o?: Record<string, unknown>) => string,
                      i18n.language,
                    )}
                  </Text>
                  {!p.enabled && (
                    <Badge size="xs" color="gray">
                      {t('web:schedule.disabled')}
                    </Badge>
                  )}
                  <PolicyHealth policy={p} />
                </Group>
                <Text size="xs" c="dimmed">
                  {[
                    p.keepLast === null
                      ? undefined
                      : t('web:backups.keepLast', { count: p.keepLast }),
                    p.keepDays === null
                      ? undefined
                      : t('web:backups.keepDays', { count: p.keepDays }),
                    p.onlyIfRunning ? t('web:backups.onlyIfRunning') : undefined,
                    p.nextRunAt === null
                      ? undefined
                      : t('web:schedule.nextRun', {
                          date: formatDateTime(p.nextRunAt, i18n.language),
                        }),
                    p.lastRunAt === null
                      ? t('web:backups.neverRan')
                      : t('web:backups.lastRun', {
                          date: formatDateTime(p.lastRunAt, i18n.language),
                        }),
                  ]
                    .filter((x) => x !== undefined)
                    .join(' · ')}
                </Text>
              </Stack>
              {canAct && (
                <Group gap="xs">
                  <Switch
                    size="sm"
                    checked={p.enabled}
                    label={t('web:schedule.enabled')}
                    onChange={(e) => {
                      m.update.mutate(
                        { policyId: p.id, enabled: e.currentTarget.checked },
                        { onError: fail },
                      );
                    }}
                  />
                  <Button
                    type="button"
                    size="compact-xs"
                    variant="default"
                    onClick={() => {
                      setEditing(p);
                    }}
                  >
                    {t('web:common.edit')}
                  </Button>
                  <Button
                    type="button"
                    size="compact-xs"
                    color="red"
                    variant="subtle"
                    onClick={() => {
                      m.remove.mutate(p.id, { onError: fail });
                    }}
                    data-testid={`policy-delete-${p.id}`}
                  >
                    {t('web:common.delete')}
                  </Button>
                </Group>
              )}
            </Group>
          ),
        )}
        {editing === 'new' && (
          <PolicyForm
            onCancel={() => {
              setEditing(undefined);
            }}
            onSubmit={(input) => {
              m.create.mutate(input, {
                onError: fail,
                onSuccess: () => {
                  setEditing(undefined);
                },
              });
            }}
          />
        )}
      </Stack>
    </Card>
  );
}

function PolicyForm({
  initial,
  onSubmit,
  onCancel,
}: {
  initial?: BackupPolicyDto;
  onSubmit: (input: {
    cron: string;
    keepLast: number | null;
    keepDays: number | null;
    onlyIfRunning: boolean;
  }) => void;
  onCancel: () => void;
}) {
  const { t } = useT();
  const [cron, setCron] = useState(initial?.cron ?? '0 4 * * *');
  const [keepLast, setKeepLast] = useState<number | null>(initial?.keepLast ?? 7);
  const [keepDays, setKeepDays] = useState<number | null>(initial?.keepDays ?? null);
  const [onlyIfRunning, setOnlyIfRunning] = useState(initial?.onlyIfRunning ?? false);
  return (
    <Card withBorder padding="sm" data-testid="policy-form">
      <Stack gap="sm">
        {/* Une politique = un horaire (cron simple compris par tous les agents) : pas d'exécution
            unique ni de multi-horaires — créer plusieurs politiques pour plusieurs horaires. */}
        <ScheduleInput
          value={{ cron, runAt: null }}
          onChange={(v) => {
            setCron(v.cron ?? '');
          }}
          allowOnce={false}
          allowMultipleTimes={false}
          testId="policy-cron"
        />
        <Group gap="xs" grow>
          <NumberInput
            label={t('web:backups.keepLastLabel')}
            min={1}
            max={1000}
            value={keepLast ?? ''}
            onChange={(v) => {
              setKeepLast(typeof v === 'number' ? v : null);
            }}
            data-testid="policy-keep"
          />
          <NumberInput
            label={t('web:backups.keepDaysLabel')}
            min={1}
            max={3650}
            value={keepDays ?? ''}
            onChange={(v) => {
              setKeepDays(typeof v === 'number' ? v : null);
            }}
          />
        </Group>
        <Checkbox
          label={t('web:backups.onlyIfRunning')}
          checked={onlyIfRunning}
          onChange={(e) => {
            setOnlyIfRunning(e.currentTarget.checked);
          }}
        />
        <Group justify="flex-end" gap="xs">
          <Button type="button" variant="default" size="xs" onClick={onCancel}>
            {t('web:common.cancel')}
          </Button>
          <Button
            type="button"
            size="xs"
            onClick={() => {
              onSubmit({ cron, keepLast, keepDays, onlyIfRunning });
            }}
            disabled={!isScheduleValid({ cron, runAt: null })}
            data-testid="policy-save"
          >
            {t('web:common.save')}
          </Button>
        </Group>
        <Text size="xs" c="dimmed">
          {t('web:backups.localTimeHint')}
        </Text>
      </Stack>
    </Card>
  );
}
