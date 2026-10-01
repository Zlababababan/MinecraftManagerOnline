/**
 * Suite de « Ajouter une machine » : attendre l'agent, choisir le dossier des serveurs, créer un
 * serveur — sans quitter la fenêtre (retour de Yassin, 01/10 : « ajouter une machine → créer un
 * serveur → lancer le serveur » est le parcours le plus fréquent, il doit s'enchaîner).
 *
 * Rien n'est obligatoire : on peut fermer à tout moment, chaque étape reste faisable depuis la
 * page de la machine. L'état vient de la liste des machines, tenue à jour par le temps réel.
 */
import { Button, Group, Loader, Stack, Text, TextInput, ThemeIcon, Title } from '@mantine/core';
import { useForm } from '@mantine/form';
import { IconCheck, IconPlus } from '@tabler/icons-react';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';

import { useAddDirectory, useMachines } from '../../api/queries.js';
import { useT } from '../../i18n/hooks.js';
import { TECHNICAL_INPUT_PROPS } from '../../lib/inputs.js';
import { ErrorAlert } from '../ErrorAlert.js';
import { CreateServerModal } from './CreateServerModal.js';

export function AfterPairing({ machineId }: { machineId: string }) {
  const { t } = useT();
  const navigate = useNavigate();
  const machines = useMachines();
  const addDir = useAddDirectory(machineId);
  const [createOpen, setCreateOpen] = useState(false);
  const form = useForm({
    initialValues: { path: '' },
    validate: { path: (v) => (v.trim() === '' ? t('web:errors.validation') : null) },
  });
  const machine = machines.data?.machines.find((m) => m.id === machineId);
  const connected = machine?.connected === true;
  const step = !connected
    ? 'waiting'
    : machine.watchedDirectories.length === 0
      ? 'directory'
      : 'ready';

  return (
    <Stack gap="xs" data-testid="after-pairing" data-step={step}>
      <Title order={3} size="h5">
        {t('web:machine.next.title')}
      </Title>
      {!connected ? (
        <Group gap="sm" wrap="nowrap">
          <Loader size="xs" />
          <Text size="sm" c="dimmed">
            {t('web:machine.next.waiting')}
          </Text>
        </Group>
      ) : (
        <>
          <Group gap="sm" wrap="nowrap">
            <ThemeIcon size="sm" radius="xl" color="teal">
              <IconCheck size={12} />
            </ThemeIcon>
            <Text size="sm">{t('web:machine.next.connected')}</Text>
          </Group>
          {machine.watchedDirectories.length === 0 ? (
            <form
              onSubmit={form.onSubmit((values) => {
                addDir.mutate({ path: values.path.trim() });
              })}
            >
              <Stack gap="xs">
                <Group align="flex-end" gap="xs" wrap="nowrap">
                  <TextInput
                    label={t('web:machine.next.directoryAsk')}
                    placeholder={t('web:machine.directoryPlaceholder')}
                    style={{ flex: 1 }}
                    {...TECHNICAL_INPUT_PROPS}
                    data-testid="after-pairing-directory"
                    {...form.getInputProps('path')}
                  />
                  <Button
                    type="submit"
                    loading={addDir.isPending}
                    data-testid="after-pairing-directory-add"
                  >
                    {t('web:common.add')}
                  </Button>
                </Group>
                <ErrorAlert error={addDir.error} />
              </Stack>
            </form>
          ) : (
            <Group justify="space-between" wrap="wrap">
              <Text size="sm">{t('web:machine.next.ready')}</Text>
              <Button
                leftSection={<IconPlus size={16} />}
                onClick={() => {
                  setCreateOpen(true);
                }}
                data-testid="after-pairing-create-server"
              >
                {t('web:install.title')}
              </Button>
            </Group>
          )}
          <CreateServerModal
            machine={machine}
            directories={machine.watchedDirectories}
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
        </>
      )}
    </Stack>
  );
}
