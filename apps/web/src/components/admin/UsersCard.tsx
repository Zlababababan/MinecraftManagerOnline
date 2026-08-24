/**
 * Réglages → Utilisateurs (admin) : liste des comptes (rôle, actif, dernière connexion), création,
 * changement de rôle, activation/désactivation, réinitialisation du mot de passe, suppression.
 * Garde-fous serveur relayés : impossible de rétrograder/désactiver/supprimer son propre compte.
 */
import {
  Button,
  Card,
  Group,
  Modal,
  PasswordInput,
  Select,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { IconKey, IconTrash } from '@tabler/icons-react';
import { useState } from 'react';

import type { UserDto } from '@mmo/protocol/client';

import { useCreateUser, useDeleteUser, useUpdateUser, useUsers } from '../../api/admin.js';
import { useMe } from '../../api/queries.js';
import { useT } from '../../i18n/hooks.js';
import { describeError } from '../../lib/errors.js';
import { formatDateTime } from '../../lib/format.js';
import { ErrorAlert } from '../ErrorAlert.js';

const ROLES = ['admin', 'operator', 'viewer'] as const;

function UserRow({
  user,
  self,
  onResetPassword,
}: {
  user: UserDto;
  self: boolean;
  onResetPassword: () => void;
}) {
  const { t, i18n } = useT();
  const update = useUpdateUser(user.id);
  const remove = useDeleteUser();
  const onError = (error: unknown): void => {
    notifications.show({ color: 'red', message: describeError(i18n, error) });
  };
  const confirmDelete = (): void => {
    modals.openConfirmModal({
      title: t('web:settings.users.deleteTitle', { username: user.username }),
      children: <Text size="sm">{t('web:settings.users.deleteConfirm')}</Text>,
      labels: { confirm: t('web:common.delete'), cancel: t('web:common.cancel') },
      confirmProps: { color: 'red' },
      onConfirm: () => {
        remove.mutate(user.id, { onError });
      },
    });
  };
  return (
    <Table.Tr data-testid={`user-${user.username}`}>
      <Table.Td fw={600}>
        {user.username}
        {self && (
          <Text span size="xs" c="dimmed">
            {' '}
            — {t('web:settings.users.you')}
          </Text>
        )}
      </Table.Td>
      <Table.Td>
        <Select
          size="xs"
          data={ROLES.map((r) => ({ value: r, label: t(`web:role.${r}`) }))}
          value={user.role}
          onChange={(role) => {
            if (role !== null && role !== user.role) {
              update.mutate({ role: role as UserDto['role'] }, { onError });
            }
          }}
          disabled={self}
          allowDeselect={false}
          w={160}
          data-testid={`user-role-${user.username}`}
        />
      </Table.Td>
      <Table.Td>
        <Switch
          size="sm"
          checked={user.isActive}
          onChange={(e) => {
            update.mutate({ isActive: e.currentTarget.checked }, { onError });
          }}
          disabled={self}
          aria-label={t('web:settings.users.active')}
          data-testid={`user-active-${user.username}`}
        />
      </Table.Td>
      <Table.Td visibleFrom="sm">
        <Text size="xs" c="dimmed">
          {user.lastLoginAt === null
            ? t('web:common.never')
            : formatDateTime(user.lastLoginAt, i18n.language)}
        </Text>
      </Table.Td>
      <Table.Td>
        <Group gap={4} wrap="nowrap" justify="flex-end">
          <Tooltip label={t('web:settings.users.resetPassword')} withArrow>
            <Button
              variant="subtle"
              size="compact-xs"
              color="gray"
              onClick={onResetPassword}
              leftSection={<IconKey size={14} />}
              data-testid={`user-password-${user.username}`}
            >
              {t('web:settings.users.password')}
            </Button>
          </Tooltip>
          <Tooltip label={t('web:common.delete')} withArrow>
            <Button
              variant="subtle"
              size="compact-xs"
              color="red"
              onClick={confirmDelete}
              disabled={self}
              leftSection={<IconTrash size={14} />}
              data-testid={`user-delete-${user.username}`}
            >
              {t('web:common.delete')}
            </Button>
          </Tooltip>
        </Group>
      </Table.Td>
    </Table.Tr>
  );
}

function PasswordModal({ user, onClose }: { user: UserDto; onClose: () => void }) {
  const { t, i18n } = useT();
  const update = useUpdateUser(user.id);
  const [password, setPassword] = useState('');
  return (
    <Modal
      opened
      onClose={onClose}
      title={t('web:settings.users.resetPasswordTitle', { username: user.username })}
    >
      <Stack gap="sm">
        <PasswordInput
          label={t('web:settings.users.newPassword')}
          description={t('web:settings.users.passwordHint')}
          value={password}
          onChange={(e) => {
            setPassword(e.currentTarget.value);
          }}
          data-testid="user-new-password"
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('web:common.cancel')}
          </Button>
          <Button
            disabled={password.length < 8}
            loading={update.isPending}
            onClick={() => {
              update.mutate(
                { password },
                {
                  onSuccess: () => {
                    notifications.show({
                      color: 'teal',
                      message: t('web:settings.users.passwordChanged'),
                    });
                    onClose();
                  },
                  onError: (error) => {
                    notifications.show({ color: 'red', message: describeError(i18n, error) });
                  },
                },
              );
            }}
            data-testid="user-password-save"
          >
            {t('web:common.save')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

export function UsersCard() {
  const { t, i18n } = useT();
  const me = useMe();
  const users = useUsers();
  const create = useCreateUser();
  const [passwordFor, setPasswordFor] = useState<UserDto | null>(null);
  const form = useForm<{ username: string; password: string; role: UserDto['role'] }>({
    initialValues: { username: '', password: '', role: 'viewer' },
  });
  return (
    <Card withBorder radius="md" padding="md" data-testid="settings-users">
      <Stack gap="sm">
        <Title order={4}>{t('web:settings.users.title')}</Title>
        <ErrorAlert error={users.error} />
        {users.data !== undefined && (
          <Table.ScrollContainer minWidth={560}>
            <Table striped>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('web:settings.users.username')}</Table.Th>
                  <Table.Th>{t('web:settings.users.role')}</Table.Th>
                  <Table.Th>{t('web:settings.users.active')}</Table.Th>
                  <Table.Th visibleFrom="sm">{t('web:settings.users.lastLogin')}</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {users.data.users.map((user) => (
                  <UserRow
                    key={user.id}
                    user={user}
                    self={user.id === me.data?.user.id}
                    onResetPassword={() => {
                      setPasswordFor(user);
                    }}
                  />
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
        <form
          onSubmit={form.onSubmit((v) => {
            create.mutate(
              { username: v.username.trim(), password: v.password, role: v.role },
              {
                onSuccess: () => {
                  notifications.show({
                    color: 'teal',
                    message: t('web:settings.users.created', { username: v.username.trim() }),
                  });
                  form.reset();
                },
                onError: (error) => {
                  notifications.show({ color: 'red', message: describeError(i18n, error) });
                },
              },
            );
          })}
        >
          <Group gap="xs" align="flex-end" wrap="wrap">
            <TextInput
              label={t('web:settings.users.newUser')}
              placeholder={t('web:settings.users.username')}
              {...form.getInputProps('username')}
              style={{ flex: '1 1 160px' }}
              autoComplete="off"
              data-testid="user-create-username"
            />
            <PasswordInput
              label={t('web:settings.users.password')}
              description={t('web:settings.users.passwordHint')}
              {...form.getInputProps('password')}
              style={{ flex: '1 1 160px' }}
              autoComplete="new-password"
              data-testid="user-create-password"
            />
            <Select
              label={t('web:settings.users.role')}
              data={ROLES.map((r) => ({ value: r, label: t(`web:role.${r}`) }))}
              allowDeselect={false}
              {...form.getInputProps('role')}
              w={170}
              data-testid="user-create-role"
            />
            <Button
              type="submit"
              disabled={form.values.username.trim() === '' || form.values.password.length < 8}
              loading={create.isPending}
              data-testid="user-create-submit"
            >
              {t('web:common.add')}
            </Button>
          </Group>
        </form>
        <Text size="xs" c="dimmed">
          {t('web:settings.users.rolesHint')}
        </Text>
      </Stack>
      {passwordFor !== null && (
        <PasswordModal
          user={passwordFor}
          onClose={() => {
            setPasswordFor(null);
          }}
        />
      )}
    </Card>
  );
}
