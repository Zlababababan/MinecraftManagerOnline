/**
 * Les deux gestes qui font ENTRER un serveur déjà installé dans la liste, posés sur la page
 * Serveurs (retour de Yassin, 02/10 : « le bouton pour actualiser la liste des serveurs est
 * loin ») — ils vivaient sur la page de la machine, donc dans Réglages avec une seule machine.
 *
 * - `ScanButton` (« Actualiser ») : relit les répertoires surveillés des machines en ligne.
 * - `AddExistingServerButton` : désigne un dossier serveur par son chemin.
 */
import { Button, Group, Modal, Select, Stack, Text, TextInput, Tooltip } from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconFolderPlus, IconRefresh } from '@tabler/icons-react';
import { useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import type { MachineDto } from '@mmo/protocol/client';

import { api } from '../../api/client.js';
import {
  invalidateAll,
  useCreateServer,
  useMachines,
  useMe,
  useServers,
  type ScanResult,
} from '../../api/queries.js';
import { useT } from '../../i18n/hooks.js';
import { describeError } from '../../lib/errors.js';
import { hasRole } from '../../lib/format.js';
import { TECHNICAL_INPUT_PROPS } from '../../lib/inputs.js';
import { canMachine } from '../../lib/permissions.js';
import { ErrorAlert } from '../ErrorAlert.js';
import { DirectoryForm } from './DirectoryForm.js';

/**
 * Relit les répertoires surveillés. `machineId` restreint à une machine (liste filtrée) ; sinon
 * toutes les machines en ligne, l'une après l'autre. Sans aucun répertoire surveillé, il n'y a
 * rien à relire : on demande le dossier sur place, puis on scanne.
 */
export function ScanButton({ machineId }: { machineId?: string | undefined }) {
  const { t, i18n } = useT();
  const queryClient = useQueryClient();
  const me = useMe();
  const machines = useMachines();
  const servers = useServers();
  const [busy, setBusy] = useState(false);
  const [askDirectory, setAskDirectory] = useState<MachineDto | undefined>(undefined);

  const isAdmin = me.data !== undefined && hasRole(me.data.user.role, 'admin');
  const online = (machines.data?.machines ?? []).filter(
    (m) =>
      m.connected &&
      canMachine(me.data, m.id, 'operator') &&
      (machineId === undefined || m.id === machineId),
  );
  if ((machines.data?.machines ?? []).length === 0) return null;

  const scan = async (targets: readonly MachineDto[]): Promise<void> => {
    setBusy(true);
    const before = new Set((servers.data?.servers ?? []).map((s) => s.id));
    try {
      let found = 0;
      let added = 0;
      let conflicts = 0;
      for (const m of targets) {
        const result = await api.post<ScanResult>(`/api/machines/${m.id}/scan`, {});
        found += result.servers.length;
        added += result.servers.filter((s) => !before.has(s.id)).length;
        conflicts += result.conflicts.length;
      }
      await invalidateAll(queryClient);
      notifications.show({
        color: 'teal',
        message: t('web:servers.scan.done', { count: found, added }),
      });
      if (conflicts > 0) {
        notifications.show({
          color: 'orange',
          message: t('web:machine.scanConflicts', { count: conflicts }),
        });
      }
    } catch (error) {
      notifications.show({ color: 'red', message: describeError(i18n, error) });
    } finally {
      setBusy(false);
    }
  };

  const click = (): void => {
    const ready = online.filter((m) => m.watchedDirectories.length > 0);
    if (ready.length > 0) {
      void scan(ready);
      return;
    }
    const first = online[0];
    if (first !== undefined && isAdmin) setAskDirectory(first);
    else notifications.show({ color: 'orange', message: t('web:servers.scan.nothing') });
  };

  return (
    <>
      <Tooltip
        label={online.length === 0 ? t('web:install.noMachineOnline') : t('web:servers.scan.hint')}
        withArrow
        multiline
        w={260}
      >
        <span>
          <Button
            size="xs"
            variant="default"
            leftSection={<IconRefresh size={14} />}
            loading={busy}
            disabled={online.length === 0}
            onClick={click}
            data-testid="servers-scan"
          >
            {t('web:servers.scan.button')}
          </Button>
        </span>
      </Tooltip>
      {askDirectory !== undefined && (
        <Modal
          opened
          onClose={() => {
            setAskDirectory(undefined);
          }}
          title={t('web:servers.scan.button')}
        >
          <Stack gap="sm" data-testid="scan-needs-directory">
            <Text size="sm">
              {t('web:servers.scan.needsDirectory', { name: askDirectory.name })}
            </Text>
            <DirectoryForm
              machineId={askDirectory.id}
              testId="scan-directory"
              onAdded={() => {
                const machine = askDirectory;
                setAskDirectory(undefined);
                void scan([machine]);
              }}
            />
          </Stack>
        </Modal>
      )}
    </>
  );
}

/** Ajouter un serveur déjà installé en donnant son dossier (admin). */
export function AddExistingServerButton({
  machineId,
  testId = 'add-server',
}: {
  /** Page d'une machine : la machine est imposée. Ailleurs, on la choisit s'il y en a plusieurs. */
  machineId?: string | undefined;
  testId?: string;
}) {
  const { t } = useT();
  const navigate = useNavigate();
  const me = useMe();
  const machines = useMachines();
  const addServer = useCreateServer();
  const [opened, setOpened] = useState(false);
  const online = (machines.data?.machines ?? []).filter(
    (m) => m.connected && (machineId === undefined || m.id === machineId),
  );
  const form = useForm({
    initialValues: { machine: '', path: '', name: '' },
    validate: { path: (v) => (v.trim() === '' ? t('web:errors.validation') : null) },
  });
  const isAdmin = me.data !== undefined && hasRole(me.data.user.role, 'admin');
  if (!isAdmin || (machines.data?.machines ?? []).length === 0) return null;
  const close = (): void => {
    setOpened(false);
    form.reset();
    addServer.reset();
  };
  const chosen = online.find((m) => m.id === form.values.machine) ?? online[0];

  return (
    <>
      <Button
        size="xs"
        variant="default"
        leftSection={<IconFolderPlus size={14} />}
        onClick={() => {
          setOpened(true);
        }}
        disabled={online.length === 0}
        data-testid={testId}
      >
        {t('web:machine.addServer')}
      </Button>
      <Modal opened={opened} onClose={close} title={t('web:machine.addServer')}>
        <form
          onSubmit={form.onSubmit((values) => {
            if (chosen === undefined) return;
            addServer.mutate(
              {
                machineId: chosen.id,
                path: values.path.trim(),
                ...(values.name.trim() === '' ? {} : { name: values.name.trim() }),
              },
              {
                onSuccess: (data) => {
                  close();
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
            {online.length > 1 && (
              <Select
                label={t('web:servers.filters.machine')}
                data={online.map((m) => ({ value: m.id, label: m.name }))}
                value={chosen?.id ?? null}
                allowDeselect={false}
                onChange={(v) => {
                  form.setFieldValue('machine', v ?? '');
                }}
                data-testid="server-machine"
              />
            )}
            <TextInput
              label={t('web:machine.directoryPath')}
              placeholder={t('web:machine.addServerPlaceholder')}
              required
              {...TECHNICAL_INPUT_PROPS}
              data-testid="server-path"
              {...form.getInputProps('path')}
            />
            <TextInput label={t('web:common.name')} {...form.getInputProps('name')} />
            <ErrorAlert error={addServer.error} />
            <Group justify="flex-end">
              <Button type="submit" loading={addServer.isPending} data-testid="server-add-submit">
                {t('web:common.add')}
              </Button>
            </Group>
          </Stack>
        </form>
      </Modal>
    </>
  );
}
