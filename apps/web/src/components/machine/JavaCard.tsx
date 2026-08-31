/**
 * Phase 9 — JRE d'une machine : inventaire (gérés par l'agent et JVM système), installation d'une
 * version majeure (chaîne Temurin → Zulu → x64 émulé décidée par le panel ; mode relais pour une
 * machine sans Internet), suppression d'un JRE géré inutilisé. La progression passe par les tasks.
 */
import {
  ActionIcon,
  Badge,
  Button,
  Card,
  Group,
  Select,
  Stack,
  Switch,
  Table,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { IconCoffee, IconTrash } from '@tabler/icons-react';
import { useState } from 'react';

import type { MachineDto } from '@mmo/protocol/client';

import { useActiveTasks } from '../../api/phase8.js';
import { useInstallJava, useJavaRuntimes, useRemoveJava } from '../../api/phase9.js';
import { useMe } from '../../api/queries.js';
import { useT } from '../../i18n/hooks.js';
import { HelpLink } from '../HelpLink.js';
import { describeError } from '../../lib/errors.js';
import { hasRole } from '../../lib/format.js';
import { TaskProgressRow } from '../tasks/TaskProgress.js';

const MAJORS = ['8', '11', '17', '21'];

export function JavaCard({ machine }: { machine: MachineDto }) {
  const { t, i18n } = useT();
  const me = useMe();
  const runtimes = useJavaRuntimes(machine.id);
  const install = useInstallJava(machine.id);
  const remove = useRemoveJava(machine.id);
  const tasks = useActiveTasks();
  const [major, setMajor] = useState<string | null>('21');
  const [relay, setRelay] = useState(false);
  const isAdmin = me.data !== undefined && hasRole(me.data.user.role, 'admin');
  const installing = (tasks.data?.tasks ?? []).filter(
    (task) => task.kind === 'java.install' && task.machineId === machine.id,
  );
  const fail = (error: unknown): void => {
    notifications.show({ color: 'red', message: describeError(i18n, error) });
  };
  const confirmRemove = (id: string, label: string): void => {
    modals.openConfirmModal({
      title: t('web:java.remove'),
      children: <Text size="sm">{t('web:java.removeConfirm', { runtime: label })}</Text>,
      labels: { confirm: t('web:common.delete'), cancel: t('web:common.cancel') },
      confirmProps: { color: 'red' },
      onConfirm: () => {
        remove.mutate(id, { onError: fail });
      },
    });
  };
  return (
    <Card withBorder radius="md" padding="md" data-testid="java-card">
      <Stack gap="sm">
        <Group justify="space-between">
          <Title order={2} size="h4">
            {t('web:java.title')}
          </Title>
          <HelpLink topic="java" />
        </Group>
        <Text size="sm" c="dimmed">
          {t('web:java.hint')}
        </Text>
        {runtimes.isPending ? (
          <Text size="sm" c="dimmed">
            {t('web:common.loading')}
          </Text>
        ) : (runtimes.data?.runtimes.length ?? 0) === 0 ? (
          <Text size="sm" c="dimmed">
            {t('web:java.none')}
          </Text>
        ) : (
          <Table striped withTableBorder data-testid="java-table">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Java</Table.Th>
                <Table.Th>{t('web:java.vendor')}</Table.Th>
                <Table.Th>{t('web:common.path')}</Table.Th>
                <Table.Th>{t('web:java.usedBy')}</Table.Th>
                {isAdmin && <Table.Th w={60} />}
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {runtimes.data?.runtimes.map((rt) => (
                <Table.Tr key={rt.id} data-testid={`java-${rt.id}`}>
                  <Table.Td>
                    <Group gap={6} wrap="nowrap">
                      <Text size="sm" fw={600}>
                        {String(rt.majorVersion)}
                      </Text>
                      <Text size="xs" c="dimmed">
                        {rt.fullVersion ?? ''}
                      </Text>
                      <Badge size="xs" variant="light" color={rt.managed ? 'teal' : 'gray'}>
                        {rt.managed ? t('web:java.managed') : t('web:java.system')}
                      </Badge>
                    </Group>
                  </Table.Td>
                  <Table.Td>{rt.vendor ?? '—'}</Table.Td>
                  <Table.Td>
                    <Text size="xs" ff="monospace" style={{ wordBreak: 'break-all' }}>
                      {rt.path}
                    </Text>
                  </Table.Td>
                  <Table.Td>{String(rt.usedBy ?? 0)}</Table.Td>
                  {isAdmin && (
                    <Table.Td>
                      {rt.managed && (
                        <Tooltip label={t('web:java.remove')} withArrow>
                          <ActionIcon
                            variant="subtle"
                            color="red"
                            aria-label={t('web:java.remove')}
                            disabled={!machine.connected || (rt.usedBy ?? 0) > 0}
                            onClick={() => {
                              confirmRemove(
                                rt.id,
                                `Java ${String(rt.majorVersion)} (${rt.vendor ?? '?'})`,
                              );
                            }}
                          >
                            <IconTrash size={16} />
                          </ActionIcon>
                        </Tooltip>
                      )}
                    </Table.Td>
                  )}
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
        {installing.map((task) => (
          <TaskProgressRow key={task.id} task={task} compact />
        ))}
        {isAdmin && (
          <Group align="flex-end" gap="xs" wrap="wrap">
            <Select
              label={t('web:java.install')}
              data={MAJORS.map((m) => ({ value: m, label: `Java ${m}` }))}
              value={major}
              onChange={setMajor}
              w={140}
              data-testid="java-major"
            />
            <Switch
              label={t('web:java.relay')}
              checked={relay}
              onChange={(e) => {
                setRelay(e.currentTarget.checked);
              }}
              data-testid="java-relay"
            />
            <Button
              type="button"
              size="sm"
              leftSection={<IconCoffee size={14} />}
              loading={install.isPending}
              disabled={!machine.connected || major === null}
              data-testid="java-install"
              onClick={() => {
                if (major === null) return;
                install.mutate(
                  { majorVersion: Number(major), relay },
                  {
                    onSuccess: (data) => {
                      notifications.show({
                        color: 'teal',
                        message: t('web:java.installStarted', {
                          sources: data.sources
                            .map((s) => `${s.vendor}${s.emulated ? ' (x64)' : ''}`)
                            .join(' → '),
                        }),
                      });
                    },
                    onError: fail,
                  },
                );
              }}
            >
              {t('web:java.installAction')}
            </Button>
          </Group>
        )}
      </Stack>
    </Card>
  );
}
