/**
 * Clés d'API (lot 8). Page Compte : les siennes — liste (nom, préfixe, rôle, expiration, dernière
 * utilisation), création (rôle ≤ le sien, expiration), jeton affiché UNE fois, révocation confirmée
 * en place. Réglages (`all`, admin) : toutes les clés avec leur compte, révocation seulement.
 */
import {
  Alert,
  Badge,
  Button,
  Card,
  Code,
  CopyButton,
  Group,
  Modal,
  SegmentedControl,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle, IconCheck, IconCopy, IconKey, IconPlus } from '@tabler/icons-react';
import { useState } from 'react';

import { roleSchema, type ApiKeyDto, type Role } from '@mmo/protocol/client';

import { useApiKeys, useCreateApiKey, useRevokeApiKey } from '../../api/api-keys.js';
import { useMe } from '../../api/queries.js';
import { useT } from '../../i18n/hooks.js';
import { describeError } from '../../lib/errors.js';
import { formatDateTime, hasRole } from '../../lib/format.js';
import { ErrorAlert } from '../ErrorAlert.js';
import { HelpLink } from '../HelpLink.js';

const EXPIRY_OPTIONS = ['30', '90', '365', 'never'] as const;
type Expiry = (typeof EXPIRY_OPTIONS)[number];

function CreateModal({
  myRole,
  onClose,
  onCreated,
}: {
  myRole: Role;
  onClose: () => void;
  onCreated: (created: { key: ApiKeyDto; token: string }) => void;
}) {
  const { t, i18n } = useT();
  const create = useCreateApiKey();
  const form = useForm<{ name: string; role: Role; expiry: Expiry }>({
    initialValues: { name: '', role: 'viewer', expiry: '90' },
    validate: {
      name: (v) => (v.trim() === '' ? t('web:errors.validation') : null),
    },
  });
  const roles = roleSchema.options.filter((r) => hasRole(myRole, r));
  return (
    <Modal opened onClose={onClose} title={t('web:apiKeys.createTitle')} data-testid="apikey-form">
      <form
        onSubmit={form.onSubmit((values) => {
          create.mutate(
            {
              name: values.name.trim(),
              role: values.role,
              ...(values.expiry === 'never' ? {} : { expiresInDays: Number(values.expiry) }),
            },
            {
              onSuccess: (created) => {
                notifications.show({
                  color: 'teal',
                  message: t('web:apiKeys.created', { name: created.key.name }),
                });
                onCreated(created);
              },
              onError: (error) => {
                notifications.show({ color: 'red', message: describeError(i18n, error) });
              },
            },
          );
        })}
      >
        <Stack gap="sm">
          <TextInput
            label={t('web:apiKeys.nameLabel')}
            placeholder={t('web:apiKeys.namePlaceholder')}
            maxLength={64}
            data-autofocus
            data-testid="apikey-name"
            {...form.getInputProps('name')}
          />
          <Stack gap={4}>
            <Text size="sm" fw={500}>
              {t('web:apiKeys.roleLabel')}
            </Text>
            {/* Pas un Select : trois choix au plus, et un groupe de boutons radio se teste sous jsdom. */}
            <SegmentedControl
              data={roles.map((r) => ({ value: r, label: t(`web:role.${r}`) }))}
              value={form.values.role}
              onChange={(value) => {
                form.setFieldValue('role', roleSchema.parse(value));
              }}
              data-testid="apikey-role"
            />
            <Text size="xs" c="dimmed">
              {t('web:apiKeys.roleHint')}
            </Text>
          </Stack>
          <Select
            label={t('web:apiKeys.expiryLabel')}
            allowDeselect={false}
            data={EXPIRY_OPTIONS.map((value) => ({
              value,
              label: t(`web:apiKeys.expiry${value === 'never' ? 'Never' : value}`),
            }))}
            data-testid="apikey-expiry"
            {...form.getInputProps('expiry')}
          />
          <ErrorAlert error={create.error} />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              {t('web:common.cancel')}
            </Button>
            <Button type="submit" loading={create.isPending} data-testid="apikey-submit">
              {t('web:apiKeys.create')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

function TokenModal({ token, onClose }: { token: string; onClose: () => void }) {
  const { t } = useT();
  return (
    <Modal opened onClose={onClose} title={t('web:apiKeys.tokenTitle')} data-testid="apikey-token">
      <Stack gap="sm">
        <Alert color="yellow" icon={<IconAlertTriangle size={16} aria-hidden />}>
          {t('web:apiKeys.tokenHint')}
        </Alert>
        <Code block data-testid="apikey-token-value">
          {token}
        </Code>
        <Text size="xs" c="dimmed">
          {t('web:apiKeys.tokenExample')}
        </Text>
        <Code
          block
        >{`curl -H "Authorization: Bearer ${token}" ${window.location.origin}/api/servers`}</Code>
        <Group justify="flex-end">
          <CopyButton value={token}>
            {({ copied, copy }) => (
              <Button
                size="xs"
                leftSection={
                  copied ? <IconCheck size={14} aria-hidden /> : <IconCopy size={14} aria-hidden />
                }
                onClick={copy}
              >
                {t(copied ? 'web:apiKeys.copied' : 'web:apiKeys.copy')}
              </Button>
            )}
          </CopyButton>
          <Button size="xs" variant="default" onClick={onClose}>
            {t('web:common.close')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

export function ApiKeysCard({ all = false }: { all?: boolean }) {
  const { t, i18n } = useT();
  const me = useMe();
  const keys = useApiKeys(all);
  const revoke = useRevokeApiKey();
  const [creating, setCreating] = useState(false);
  const [token, setToken] = useState<string | undefined>(undefined);
  const [confirming, setConfirming] = useState<ApiKeyDto | undefined>(undefined);
  const now = Date.now();
  const myRole = me.data?.user.role ?? 'viewer';
  const list = keys.data?.keys;

  return (
    <Card withBorder radius="md" padding="md" data-testid={all ? 'settings-api-keys' : 'api-keys'}>
      <Stack gap="sm">
        <Group justify="space-between" align="flex-start">
          <div>
            <Title order={2} size="h4">
              <Group gap={6}>
                <IconKey size={18} aria-hidden />
                {t(all ? 'web:apiKeys.adminTitle' : 'web:apiKeys.title')}
              </Group>
            </Title>
            <Text size="sm" c="dimmed">
              {t(all ? 'web:apiKeys.adminHint' : 'web:apiKeys.hint')}{' '}
              <HelpLink topic="apiKeys" inline />
            </Text>
          </div>
          {!all && (
            <Button
              size="xs"
              leftSection={<IconPlus size={14} aria-hidden />}
              onClick={() => {
                setCreating(true);
              }}
              data-testid="apikey-create"
            >
              {t('web:apiKeys.create')}
            </Button>
          )}
        </Group>
        <ErrorAlert error={keys.error} />
        {list?.length === 0 && (
          <Text size="sm" c="dimmed">
            {t('web:apiKeys.none')}
          </Text>
        )}
        {list !== undefined && list.length > 0 && (
          <Table.ScrollContainer minWidth={640}>
            <Table verticalSpacing="xs" fz="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('web:apiKeys.name')}</Table.Th>
                  {all && <Table.Th>{t('web:apiKeys.owner')}</Table.Th>}
                  <Table.Th>{t('web:apiKeys.key')}</Table.Th>
                  <Table.Th>{t('web:apiKeys.role')}</Table.Th>
                  <Table.Th>{t('web:apiKeys.expires')}</Table.Th>
                  <Table.Th>{t('web:apiKeys.lastUsed')}</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {list.map((key) => {
                  const expired = key.expiresAt !== null && key.expiresAt <= now;
                  return (
                    <Table.Tr key={key.id} data-testid={`apikey-row-${key.id}`}>
                      <Table.Td>{key.name}</Table.Td>
                      {all && <Table.Td>{key.username}</Table.Td>}
                      <Table.Td>
                        <Code>{key.prefix}…</Code>
                      </Table.Td>
                      <Table.Td>{t(`web:role.${key.role}`)}</Table.Td>
                      <Table.Td>
                        {key.expiresAt === null ? (
                          t('web:apiKeys.never')
                        ) : expired ? (
                          <Badge
                            color="red"
                            variant="light"
                            data-testid={`apikey-expired-${key.id}`}
                          >
                            {t('web:apiKeys.expired')}
                          </Badge>
                        ) : (
                          formatDateTime(key.expiresAt, i18n.language)
                        )}
                      </Table.Td>
                      <Table.Td>
                        {key.lastUsedAt === null
                          ? t('web:apiKeys.neverUsed')
                          : `${formatDateTime(key.lastUsedAt, i18n.language)}${
                              key.lastUsedIp === null ? '' : ` · ${key.lastUsedIp}`
                            }`}
                      </Table.Td>
                      <Table.Td>
                        <Button
                          size="compact-xs"
                          variant="subtle"
                          color="red"
                          onClick={() => {
                            setConfirming(key);
                          }}
                          data-testid={`apikey-revoke-${key.id}`}
                        >
                          {t('web:apiKeys.revoke')}
                        </Button>
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
        {confirming !== undefined && (
          <Alert
            color="red"
            icon={<IconAlertTriangle size={16} aria-hidden />}
            data-testid="apikey-confirm-revoke"
          >
            <Stack gap="xs">
              <Text size="sm">{t('web:apiKeys.confirmRevoke', { name: confirming.name })}</Text>
              <Group gap="xs">
                <Button
                  size="xs"
                  variant="default"
                  onClick={() => {
                    setConfirming(undefined);
                  }}
                >
                  {t('web:common.cancel')}
                </Button>
                <Button
                  size="xs"
                  color="red"
                  loading={revoke.isPending}
                  onClick={() => {
                    revoke.mutate(confirming.id, {
                      onSuccess: () => {
                        setConfirming(undefined);
                        notifications.show({ color: 'teal', message: t('web:apiKeys.revoked') });
                      },
                      onError: (error) => {
                        notifications.show({ color: 'red', message: describeError(i18n, error) });
                      },
                    });
                  }}
                  data-testid="apikey-confirm-revoke-yes"
                >
                  {t('web:common.confirm')}
                </Button>
              </Group>
            </Stack>
          </Alert>
        )}
      </Stack>
      {creating && (
        <CreateModal
          myRole={myRole}
          onClose={() => {
            setCreating(false);
          }}
          onCreated={(created) => {
            setCreating(false);
            setToken(created.token);
          }}
        />
      )}
      {token !== undefined && (
        <TokenModal
          token={token}
          onClose={() => {
            setToken(undefined);
          }}
        />
      )}
    </Card>
  );
}
