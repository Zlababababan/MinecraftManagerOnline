/** Machines : liste + ajout (code d'appairage affiché une seule fois) + conflits de marqueur. */
import {
  ActionIcon,
  Button,
  Card,
  Group,
  Modal,
  Stack,
  Text,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useT } from '../i18n/hooks.js';

import type { MachineDto, PairingCodeDto } from '@mmo/protocol/client';

import {
  useConflicts,
  useCreateMachine,
  useDeleteMachine,
  useMachines,
  useMe,
  useServers,
} from '../api/queries.js';
import { ConflictsPanel } from '../components/ConflictsPanel.js';
import { ReleasesCard } from '../components/admin/ReleasesCard.js';
import { ErrorAlert } from '../components/ErrorAlert.js';
import { MachineHeader } from '../components/MachineHeader.js';
import { PairingCodeCard } from '../components/PairingCodeCard.js';
import { describeError } from '../lib/errors.js';
import { hasRole } from '../lib/format.js';
import { useNow } from '../lib/hooks.js';

export function AddMachineModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const { t } = useT();
  const create = useCreateMachine();
  const [pairing, setPairing] = useState<PairingCodeDto | undefined>(undefined);
  const form = useForm({
    initialValues: { name: '' },
    validate: { name: (v) => (v.trim() === '' ? t('web:errors.validation') : null) },
  });
  const close = (): void => {
    setPairing(undefined);
    form.reset();
    create.reset();
    onClose();
  };
  const submit = form.onSubmit((values) => {
    create.mutate(
      { name: values.name.trim() },
      {
        onSuccess: (data) => {
          setPairing(data.pairing);
        },
      },
    );
  });
  return (
    <Modal opened={opened} onClose={close} title={t('web:machine.create.title')} size="lg">
      {pairing === undefined ? (
        <form onSubmit={submit}>
          <Stack gap="sm">
            <TextInput
              label={t('web:machine.create.name')}
              placeholder={t('web:machine.create.namePlaceholder')}
              required
              autoFocus
              data-testid="machine-name"
              {...form.getInputProps('name')}
            />
            <ErrorAlert error={create.error} />
            <Group justify="flex-end">
              <Button type="submit" loading={create.isPending} data-testid="machine-create">
                {t('web:machine.create.submit')}
              </Button>
            </Group>
          </Stack>
        </form>
      ) : (
        <Stack gap="md">
          <PairingCodeCard pairing={pairing} />
          <Group justify="flex-end">
            <Button onClick={close} data-testid="pairing-close">
              {t('web:common.close')}
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}

export function MachinesPage({ openAdd }: { openAdd: boolean }) {
  const { t, i18n } = useT();
  const navigate = useNavigate();
  const me = useMe();
  const machines = useMachines();
  const servers = useServers();
  const conflicts = useConflicts();
  const now = useNow(10_000);
  const removeMachine = useDeleteMachine();
  const isAdmin = me.data !== undefined && hasRole(me.data.user.role, 'admin');
  const setOpen = (open: boolean): void => {
    void navigate({ to: '/machines', search: open ? { add: true } : {}, replace: true });
  };
  const confirmRemove = (machine: MachineDto): void => {
    modals.openConfirmModal({
      title: t('web:machine.remove'),
      children: <Text size="sm">{t('web:machine.removeConfirm', { name: machine.name })}</Text>,
      labels: { confirm: t('web:common.delete'), cancel: t('web:common.cancel') },
      confirmProps: { color: 'red' },
      onConfirm: () => {
        removeMachine.mutate(machine.id, {
          onError: (error) => {
            notifications.show({ color: 'red', message: describeError(i18n, error) });
          },
        });
      },
    });
  };

  return (
    <Stack gap="lg" data-testid="machines-page">
      <Group justify="space-between">
        <Title order={2}>{t('web:machine.title')}</Title>
        {isAdmin && (
          <Button
            leftSection={<IconPlus size={16} />}
            size="sm"
            onClick={() => {
              setOpen(true);
            }}
            data-testid="add-machine"
          >
            {t('web:dashboard.addMachine')}
          </Button>
        )}
      </Group>
      <ErrorAlert error={machines.error} />
      {conflicts.data !== undefined && <ConflictsPanel conflicts={conflicts.data.conflicts} />}
      {machines.data?.machines.length === 0 && (
        <Text c="dimmed">{t('web:dashboard.noMachines')}</Text>
      )}
      {machines.data?.machines.map((machine) => {
        const count = servers.data?.servers.filter((s) => s.machineId === machine.id).length;
        return (
          <Card
            key={machine.id}
            withBorder
            radius="md"
            padding="md"
            data-testid="machine-row"
            data-machine-id={machine.id}
          >
            <Stack gap="xs">
              <Group align="flex-start" wrap="nowrap" gap="xs">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <MachineHeader machine={machine} now={now} />
                </div>
                {isAdmin && (
                  <Tooltip label={t('web:machine.remove')} withArrow>
                    <ActionIcon
                      variant="subtle"
                      color="red"
                      aria-label={t('web:machine.remove')}
                      onClick={() => {
                        confirmRemove(machine);
                      }}
                      data-testid="machine-remove"
                    >
                      <IconTrash size={16} />
                    </ActionIcon>
                  </Tooltip>
                )}
              </Group>
              <Text size="xs" c="dimmed">
                {t('web:machine.servers')} : {count ?? '…'} · {t('web:machine.directories')} :{' '}
                {machine.watchedDirectories.length}
                {machine.agentVersion === null
                  ? ''
                  : ` · ${t('web:machine.agent')} ${machine.agentVersion}`}
                {machine.updateAvailable === true
                  ? ` (${t('web:agentUpdate.available', { version: machine.latestRelease ?? '' })})`
                  : ''}
              </Text>
            </Stack>
          </Card>
        );
      })}
      {isAdmin && <ReleasesCard />}
      <AddMachineModal
        opened={openAdd && isAdmin}
        onClose={() => {
          setOpen(false);
        }}
      />
    </Stack>
  );
}
