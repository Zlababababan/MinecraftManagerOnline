/**
 * Réglages → Utilisateurs → « Serveurs… » (lot 8) : ce qu'un compte limité a le droit de voir.
 * Machines (une machine accordée couvre tous ses serveurs, présents et futurs) puis serveurs
 * groupés par machine, chacun avec un rôle plafonné par le rôle du compte. Enregistrer remplace
 * l'ensemble des portées ; le panel ferme les connexions du compte, qui relit ses listes.
 */
import { Alert, Button, Checkbox, Group, Loader, Modal, Select, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useState } from 'react';

import type { GrantRole, UserDto, UserGrantsDto } from '@mmo/protocol/client';

import { useSetUserGrants, useUserGrants } from '../../api/admin.js';
import { useMachines, useServers } from '../../api/queries.js';
import { useT } from '../../i18n/hooks.js';
import { describeError } from '../../lib/errors.js';
import { hasRole } from '../../lib/format.js';
import { ErrorAlert } from '../ErrorAlert.js';

const GRANT_ROLES: readonly GrantRole[] = ['viewer', 'operator'];

type Choice = Map<string, GrantRole>;

function toChoice<K extends 'serverId' | 'machineId'>(
  rows: ({ role: GrantRole } & Record<K, string>)[],
  key: K,
): Choice {
  return new Map(rows.map((g) => [g[key], g.role]));
}

function GrantsForm({
  user,
  initial,
  onClose,
}: {
  user: UserDto;
  initial: UserGrantsDto;
  onClose: () => void;
}) {
  const { t, i18n } = useT();
  const machines = useMachines();
  const servers = useServers();
  const save = useSetUserGrants(user.id);
  const [machineChoice, setMachineChoice] = useState<Choice>(() =>
    toChoice(initial.machines, 'machineId'),
  );
  const [serverChoice, setServerChoice] = useState<Choice>(() =>
    toChoice(initial.servers, 'serverId'),
  );
  // Le rôle du compte est le plafond : un lecteur n'a que « lecture » à offrir.
  const roles = GRANT_ROLES.filter((r) => hasRole(user.role, r));
  const defaultRole: GrantRole = roles.includes('operator') ? 'operator' : 'viewer';
  const roleData = roles.map((r) => ({ value: r, label: t(`web:role.${r}`) }));

  const toggle = (
    choice: Choice,
    set: (next: Choice) => void,
    id: string,
    checked: boolean,
  ): void => {
    const next = new Map(choice);
    if (checked) next.set(id, next.get(id) ?? defaultRole);
    else next.delete(id);
    set(next);
  };
  const setRole = (
    choice: Choice,
    set: (next: Choice) => void,
    id: string,
    role: string | null,
  ) => {
    if (role !== 'viewer' && role !== 'operator') return;
    const next = new Map(choice);
    next.set(id, role);
    set(next);
  };

  const machineList = machines.data?.machines ?? [];
  const serverList = servers.data?.servers ?? [];
  const nothing = machineChoice.size === 0 && serverChoice.size === 0;

  return (
    <Stack gap="md">
      <Text size="sm" c="dimmed">
        {t('web:settings.users.grantsHint')}
      </Text>
      {user.role === 'viewer' && (
        <Text size="xs" c="dimmed">
          {t('web:settings.users.grantsCeiling', { role: t('web:role.viewer') })}
        </Text>
      )}
      <ErrorAlert error={machines.error ?? servers.error} />
      <Stack gap="xs">
        <Text fw={600} size="sm">
          {t('web:settings.users.grantsMachines')}
        </Text>
        {machineList.map((m) => {
          const role = machineChoice.get(m.id);
          return (
            <Group key={m.id} gap="sm" wrap="nowrap" justify="space-between">
              <Checkbox
                label={m.name}
                checked={role !== undefined}
                onChange={(e) => {
                  toggle(machineChoice, setMachineChoice, m.id, e.currentTarget.checked);
                }}
                data-testid={`grant-machine-${m.id}`}
              />
              <Select
                size="xs"
                w={140}
                data={roleData}
                value={role ?? defaultRole}
                disabled={role === undefined || roles.length === 1}
                allowDeselect={false}
                onChange={(v) => {
                  setRole(machineChoice, setMachineChoice, m.id, v);
                }}
                aria-label={`${t('web:settings.users.grantsRole')} — ${m.name}`}
                data-testid={`grant-machine-role-${m.id}`}
              />
            </Group>
          );
        })}
      </Stack>
      <Stack gap="xs">
        <Text fw={600} size="sm">
          {t('web:settings.users.grantsServers')}
        </Text>
        {serverList.map((s) => {
          const covered = machineChoice.has(s.machineId);
          const role = serverChoice.get(s.id);
          const machineName = machineList.find((m) => m.id === s.machineId)?.name ?? s.machineId;
          return (
            <Group key={s.id} gap="sm" wrap="nowrap" justify="space-between">
              <Checkbox
                label={`${s.name} — ${machineName}`}
                checked={covered || role !== undefined}
                disabled={covered}
                description={covered ? t('web:settings.users.grantsCoveredByMachine') : undefined}
                onChange={(e) => {
                  toggle(serverChoice, setServerChoice, s.id, e.currentTarget.checked);
                }}
                data-testid={`grant-server-${s.id}`}
              />
              {!covered && (
                <Select
                  size="xs"
                  w={140}
                  data={roleData}
                  value={role ?? defaultRole}
                  disabled={role === undefined || roles.length === 1}
                  allowDeselect={false}
                  onChange={(v) => {
                    setRole(serverChoice, setServerChoice, s.id, v);
                  }}
                  aria-label={`${t('web:settings.users.grantsRole')} — ${s.name}`}
                  data-testid={`grant-server-role-${s.id}`}
                />
              )}
            </Group>
          );
        })}
      </Stack>
      {nothing && (
        <Alert color="yellow" variant="light" data-testid="grants-none">
          {t('web:settings.users.grantsNone')}
        </Alert>
      )}
      <Group justify="flex-end">
        <Button variant="default" onClick={onClose}>
          {t('web:common.cancel')}
        </Button>
        <Button
          loading={save.isPending}
          onClick={() => {
            save.mutate(
              {
                machines: [...machineChoice].map(([machineId, role]) => ({ machineId, role })),
                // Un serveur couvert par sa machine n'a pas besoin de ligne propre.
                servers: [...serverChoice]
                  .filter(([serverId]) => {
                    const row = serverList.find((s) => s.id === serverId);
                    return row === undefined || !machineChoice.has(row.machineId);
                  })
                  .map(([serverId, role]) => ({ serverId, role })),
              },
              {
                onSuccess: () => {
                  notifications.show({
                    color: 'teal',
                    message: t('web:settings.users.grantsSaved'),
                  });
                  onClose();
                },
                onError: (error) => {
                  notifications.show({ color: 'red', message: describeError(i18n, error) });
                },
              },
            );
          }}
          data-testid="grants-save"
        >
          {t('web:common.save')}
        </Button>
      </Group>
    </Stack>
  );
}

export function GrantsModal({ user, onClose }: { user: UserDto; onClose: () => void }) {
  const { t } = useT();
  const grants = useUserGrants(user.id);
  return (
    <Modal
      opened
      onClose={onClose}
      title={t('web:settings.users.grantsTitle', { username: user.username })}
      size="lg"
      data-testid="grants-modal"
    >
      <ErrorAlert error={grants.error} />
      {grants.data === undefined ? (
        grants.error === null && <Loader size="sm" />
      ) : (
        <GrantsForm user={user} initial={grants.data.grants} onClose={onClose} />
      )}
    </Modal>
  );
}
