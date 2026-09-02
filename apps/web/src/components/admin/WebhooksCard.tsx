/**
 * Lot 4 — carte « Webhooks » (admin, Réglages) : liste (genre, URL masquée, catégories, santé),
 * création et édition dans une modale (Discord ou JSON signé, langue, catégories groupées comme
 * les préférences de notification), test immédiat, secret affiché UNE fois (création, rotation),
 * suppression confirmée en place. Un webhook en échec s'affiche en rouge avec sa dernière erreur
 * — la même information que l'événement `webhook.failed`.
 */
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Code,
  CopyButton,
  Group,
  Modal,
  SegmentedControl,
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
import { notifications } from '@mantine/notifications';
import {
  IconAlertTriangle,
  IconCheck,
  IconCopy,
  IconKey,
  IconPencil,
  IconPlus,
  IconSend,
  IconTrash,
} from '@tabler/icons-react';
import type { i18n as I18nInstance } from 'i18next';
import { useState } from 'react';

import {
  NOTIFICATION_DEFAULTS,
  NOTIFICATION_GROUPS,
  NOTIFICATION_TYPES,
  type NotificationType,
  type WebhookDto,
  type WebhookKind,
} from '@mmo/protocol/client';

import {
  useCreateWebhook,
  useDeleteWebhook,
  useRotateWebhookSecret,
  useTestWebhook,
  useUpdateWebhook,
  useWebhooks,
} from '../../api/webhooks.js';
import { useT } from '../../i18n/hooks.js';
import { tDynamic } from '../../i18n/index.js';
import { describeError } from '../../lib/errors.js';
import { formatDateTime } from '../../lib/format.js';
import { TECHNICAL_INPUT_PROPS } from '../../lib/inputs.js';
import { HelpLink } from '../HelpLink.js';

const DEFAULT_TYPES: NotificationType[] = NOTIFICATION_TYPES.filter(
  (type) => NOTIFICATION_DEFAULTS[type],
);

interface FormValues {
  name: string;
  kind: WebhookKind;
  url: string;
  locale: 'fr' | 'en';
  types: NotificationType[];
}

function typeLabel(i18n: I18nInstance, type: NotificationType): string {
  return tDynamic(i18n, `web:notifications.types.${type.replace('.', '_')}`);
}

function WebhookFormModal({
  initial,
  pending,
  onSubmit,
  onClose,
}: {
  initial?: WebhookDto;
  pending: boolean;
  onSubmit: (values: FormValues) => void;
  onClose: () => void;
}) {
  const { t, i18n } = useT();
  const editing = initial !== undefined;
  const form = useForm<FormValues>({
    initialValues: {
      name: initial?.name ?? '',
      kind: initial?.kind ?? 'discord',
      // En édition, l'URL affichée est masquée : le champ reste vide et ne change rien s'il le reste.
      url: '',
      locale: initial?.locale ?? (i18n.language.startsWith('fr') ? 'fr' : 'en'),
      types: initial?.types ?? DEFAULT_TYPES,
    },
    validate: {
      name: (value) => (value.trim() === '' ? t('web:settings.webhooks.nameRequired') : null),
      url: (value) =>
        !editing && value.trim() === '' ? t('web:settings.webhooks.urlRequired') : null,
    },
  });
  const kind = form.values.kind;
  return (
    <Modal
      opened
      onClose={onClose}
      title={t(editing ? 'web:settings.webhooks.editTitle' : 'web:settings.webhooks.addTitle')}
      size="lg"
      data-testid="webhook-form"
    >
      <form onSubmit={form.onSubmit(onSubmit)}>
        <Stack gap="sm">
          <TextInput
            label={t('web:settings.webhooks.name')}
            required
            {...form.getInputProps('name')}
            data-testid="webhook-name"
          />
          {!editing && (
            <SegmentedControl
              data={[
                { value: 'discord', label: t('web:settings.webhooks.kindDiscord') },
                { value: 'json', label: t('web:settings.webhooks.kindJson') },
              ]}
              value={kind}
              onChange={(value) => {
                form.setFieldValue('kind', value === 'json' ? 'json' : 'discord');
              }}
              data-testid="webhook-kind"
            />
          )}
          <TextInput
            label={t('web:settings.webhooks.url')}
            placeholder={kind === 'discord' ? 'https://discord.com/api/webhooks/…' : 'https://…'}
            description={t(
              editing
                ? 'web:settings.webhooks.urlKeep'
                : kind === 'discord'
                  ? 'web:settings.webhooks.urlDiscordHint'
                  : 'web:settings.webhooks.urlJsonHint',
            )}
            {...TECHNICAL_INPUT_PROPS}
            {...form.getInputProps('url')}
            data-testid="webhook-url"
          />
          <Select
            label={t('web:settings.webhooks.locale')}
            data={[
              { value: 'fr', label: 'Français' },
              { value: 'en', label: 'English' },
            ]}
            allowDeselect={false}
            value={form.values.locale}
            onChange={(value) => {
              if (value === 'fr' || value === 'en') form.setFieldValue('locale', value);
            }}
            data-testid="webhook-locale"
          />
          <Group justify="space-between" align="center">
            <Text size="sm" fw={500}>
              {t('web:settings.webhooks.categories')}
            </Text>
            <Group gap="xs">
              <Button
                variant="subtle"
                size="compact-xs"
                onClick={() => {
                  form.setFieldValue('types', [...NOTIFICATION_TYPES]);
                }}
              >
                {t('web:settings.webhooks.all')}
              </Button>
              <Button
                variant="subtle"
                size="compact-xs"
                onClick={() => {
                  form.setFieldValue('types', DEFAULT_TYPES);
                }}
              >
                {t('web:settings.webhooks.defaults')}
              </Button>
              <Button
                variant="subtle"
                size="compact-xs"
                onClick={() => {
                  form.setFieldValue('types', []);
                }}
                data-testid="webhook-types-none"
              >
                {t('web:settings.webhooks.none')}
              </Button>
            </Group>
          </Group>
          <Checkbox.Group
            value={form.values.types}
            onChange={(values) => {
              form.setFieldValue(
                'types',
                values.filter((v): v is NotificationType =>
                  (NOTIFICATION_TYPES as readonly string[]).includes(v),
                ),
              );
            }}
          >
            <Stack gap="xs">
              {NOTIFICATION_GROUPS.map((group) => (
                <Stack gap={4} key={group.id}>
                  <Text size="xs" fw={600} tt="uppercase" c="dimmed">
                    {tDynamic(i18n, `web:notifications.groups.${group.id}`)}
                  </Text>
                  {group.types.map((type: NotificationType) => (
                    <Checkbox
                      key={type}
                      value={type}
                      label={typeLabel(i18n, type)}
                      size="xs"
                      data-testid={`webhook-type-${type}`}
                    />
                  ))}
                </Stack>
              ))}
            </Stack>
          </Checkbox.Group>
          <Group justify="flex-end">
            <Button variant="default" size="xs" onClick={onClose}>
              {t('web:common.cancel')}
            </Button>
            <Button type="submit" size="xs" loading={pending} data-testid="webhook-save">
              {t(editing ? 'web:common.save' : 'web:settings.webhooks.create')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

function SecretModal({ secret, onClose }: { secret: string; onClose: () => void }) {
  const { t } = useT();
  return (
    <Modal
      opened
      onClose={onClose}
      title={t('web:settings.webhooks.secretTitle')}
      data-testid="webhook-secret"
    >
      <Stack gap="sm">
        <Alert color="yellow" icon={<IconAlertTriangle size={16} aria-hidden />}>
          {t('web:settings.webhooks.secretHint')}
        </Alert>
        <Code block data-testid="webhook-secret-value">
          {secret}
        </Code>
        <Group justify="flex-end">
          <CopyButton value={secret}>
            {({ copied, copy }) => (
              <Button
                size="xs"
                leftSection={
                  copied ? <IconCheck size={14} aria-hidden /> : <IconCopy size={14} aria-hidden />
                }
                onClick={copy}
              >
                {t(copied ? 'web:settings.webhooks.secretCopied' : 'web:settings.webhooks.copy')}
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

export function WebhooksCard() {
  const { t, i18n } = useT();
  const webhooks = useWebhooks();
  const create = useCreateWebhook();
  const update = useUpdateWebhook();
  const remove = useDeleteWebhook();
  const test = useTestWebhook();
  const rotate = useRotateWebhookSecret();
  const [editing, setEditing] = useState<WebhookDto | 'new' | undefined>(undefined);
  const [secret, setSecret] = useState<string | undefined>(undefined);
  const [confirming, setConfirming] = useState<WebhookDto | undefined>(undefined);
  const rows = webhooks.data?.webhooks ?? [];
  const fail = (error: unknown): void => {
    notifications.show({ color: 'red', message: describeError(i18n, error) });
  };

  const submit = (values: FormValues): void => {
    if (editing === 'new') {
      create.mutate(
        {
          name: values.name.trim(),
          kind: values.kind,
          url: values.url.trim(),
          locale: values.locale,
          types: values.types,
        },
        {
          onSuccess: ({ secret: created }) => {
            setEditing(undefined);
            notifications.show({ color: 'teal', message: t('web:settings.webhooks.created') });
            if (created !== null) setSecret(created);
          },
          onError: fail,
        },
      );
      return;
    }
    if (editing === undefined) return;
    const url = values.url.trim();
    update.mutate(
      {
        id: editing.id,
        patch: {
          name: values.name.trim(),
          locale: values.locale,
          types: values.types,
          ...(url === '' ? {} : { url }),
        },
      },
      {
        onSuccess: () => {
          setEditing(undefined);
          notifications.show({ color: 'teal', message: t('web:settings.webhooks.updated') });
        },
        onError: fail,
      },
    );
  };

  const health = (row: WebhookDto) => {
    if (row.failCount > 0) {
      return (
        <Stack gap={2}>
          <Badge color="red" size="sm" data-testid={`webhook-failing-${row.id}`}>
            {t('web:settings.webhooks.healthFailing', { count: row.failCount })}
          </Badge>
          {row.lastError !== null && (
            <Text size="xs" c="red" lineClamp={2} data-testid={`webhook-last-error-${row.id}`}>
              {row.lastError}
            </Text>
          )}
        </Stack>
      );
    }
    if (row.lastDeliveredAt !== null) {
      return (
        <Text size="xs" c="dimmed">
          {t('web:settings.webhooks.healthOk', {
            date: formatDateTime(row.lastDeliveredAt, i18n.language),
          })}
        </Text>
      );
    }
    return (
      <Text size="xs" c="dimmed">
        {t('web:settings.webhooks.healthNever')}
      </Text>
    );
  };

  return (
    <Card withBorder radius="md" padding="md" data-testid="settings-webhooks">
      <Stack gap="sm">
        <Group justify="space-between" align="flex-start">
          <Title order={2} size="h4">
            {t('web:settings.webhooks.title')}
          </Title>
          <Button
            size="xs"
            leftSection={<IconPlus size={16} aria-hidden />}
            onClick={() => {
              setEditing('new');
            }}
            data-testid="webhook-add"
          >
            {t('web:settings.webhooks.add')}
          </Button>
        </Group>
        <Text size="xs" c="dimmed">
          {t('web:settings.webhooks.hint')} <HelpLink topic="webhooks" inline />
        </Text>
        {webhooks.data !== undefined && rows.length === 0 && (
          <Text size="sm" c="dimmed" data-testid="webhooks-empty">
            {t('web:settings.webhooks.empty')}
          </Text>
        )}
        {rows.length > 0 && (
          <Table.ScrollContainer
            minWidth={640}
            scrollAreaProps={{ viewportProps: { tabIndex: 0 } }}
          >
            <Table verticalSpacing="xs" data-testid="webhooks-table">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('web:settings.webhooks.name')}</Table.Th>
                  <Table.Th>{t('web:settings.webhooks.url')}</Table.Th>
                  <Table.Th>{t('web:settings.webhooks.health')}</Table.Th>
                  <Table.Th>{t('web:settings.webhooks.enabled')}</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.map((row) => (
                  <Table.Tr key={row.id} data-testid={`webhook-row-${row.id}`}>
                    <Table.Td>
                      <Stack gap={2}>
                        <Text size="sm" fw={500}>
                          {row.name}
                        </Text>
                        <Group gap={6}>
                          <Badge
                            size="xs"
                            variant="light"
                            color={row.kind === 'discord' ? 'indigo' : 'teal'}
                          >
                            {t(
                              row.kind === 'discord'
                                ? 'web:settings.webhooks.kindDiscord'
                                : 'web:settings.webhooks.kindJson',
                            )}
                          </Badge>
                          <Text size="xs" c="dimmed">
                            {t('web:settings.webhooks.categoriesCount', {
                              count: row.types.length,
                            })}
                          </Text>
                        </Group>
                      </Stack>
                    </Table.Td>
                    <Table.Td>
                      <Code style={{ wordBreak: 'break-all' }}>{row.url}</Code>
                    </Table.Td>
                    <Table.Td>{health(row)}</Table.Td>
                    <Table.Td>
                      <Switch
                        size="sm"
                        checked={row.enabled}
                        aria-label={`${t('web:settings.webhooks.enabled')} — ${row.name}`}
                        onChange={(event) => {
                          update.mutate(
                            { id: row.id, patch: { enabled: event.currentTarget.checked } },
                            { onError: fail },
                          );
                        }}
                        data-testid={`webhook-enabled-${row.id}`}
                      />
                    </Table.Td>
                    <Table.Td>
                      <Group gap={4} justify="flex-end" wrap="nowrap">
                        <Tooltip label={t('web:settings.webhooks.test')}>
                          <ActionIcon
                            variant="subtle"
                            aria-label={`${t('web:settings.webhooks.test')} — ${row.name}`}
                            loading={test.isPending && test.variables === row.id}
                            onClick={() => {
                              test.mutate(row.id, {
                                onSuccess: ({ result }) => {
                                  notifications.show(
                                    result.ok
                                      ? {
                                          color: 'teal',
                                          message: t('web:settings.webhooks.testOk', {
                                            status: result.status ?? 0,
                                          }),
                                        }
                                      : {
                                          color: 'red',
                                          message: t('web:settings.webhooks.testFailed', {
                                            error: result.error ?? '',
                                          }),
                                        },
                                  );
                                },
                                onError: fail,
                              });
                            }}
                            data-testid={`webhook-test-${row.id}`}
                          >
                            <IconSend size={16} aria-hidden />
                          </ActionIcon>
                        </Tooltip>
                        <Tooltip label={t('web:settings.webhooks.edit')}>
                          <ActionIcon
                            variant="subtle"
                            aria-label={`${t('web:settings.webhooks.edit')} — ${row.name}`}
                            onClick={() => {
                              setEditing(row);
                            }}
                            data-testid={`webhook-edit-${row.id}`}
                          >
                            <IconPencil size={16} aria-hidden />
                          </ActionIcon>
                        </Tooltip>
                        {row.kind === 'json' && (
                          <Tooltip label={t('web:settings.webhooks.rotate')}>
                            <ActionIcon
                              variant="subtle"
                              aria-label={`${t('web:settings.webhooks.rotate')} — ${row.name}`}
                              loading={rotate.isPending && rotate.variables === row.id}
                              onClick={() => {
                                rotate.mutate(row.id, {
                                  onSuccess: ({ secret: next }) => {
                                    setSecret(next);
                                  },
                                  onError: fail,
                                });
                              }}
                              data-testid={`webhook-rotate-${row.id}`}
                            >
                              <IconKey size={16} aria-hidden />
                            </ActionIcon>
                          </Tooltip>
                        )}
                        <Tooltip label={t('web:settings.webhooks.delete')}>
                          <ActionIcon
                            variant="subtle"
                            color="red"
                            aria-label={`${t('web:settings.webhooks.delete')} — ${row.name}`}
                            onClick={() => {
                              setConfirming(row);
                            }}
                            data-testid={`webhook-delete-${row.id}`}
                          >
                            <IconTrash size={16} aria-hidden />
                          </ActionIcon>
                        </Tooltip>
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
        {confirming !== undefined && (
          <Alert
            color="red"
            icon={<IconAlertTriangle size={16} aria-hidden />}
            data-testid="webhook-confirm-delete"
          >
            <Group justify="space-between">
              <Text size="sm">
                {t('web:settings.webhooks.confirmDelete', { name: confirming.name })}
              </Text>
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
                  loading={remove.isPending}
                  onClick={() => {
                    remove.mutate(confirming.id, {
                      onSuccess: () => {
                        setConfirming(undefined);
                        notifications.show({
                          color: 'gray',
                          message: t('web:settings.webhooks.deleted'),
                        });
                      },
                      onError: fail,
                    });
                  }}
                  data-testid="webhook-confirm-delete-yes"
                >
                  {t('web:common.confirm')}
                </Button>
              </Group>
            </Group>
          </Alert>
        )}
      </Stack>
      {editing !== undefined && (
        <WebhookFormModal
          {...(editing === 'new' ? {} : { initial: editing })}
          pending={create.isPending || update.isPending}
          onSubmit={submit}
          onClose={() => {
            setEditing(undefined);
          }}
        />
      )}
      {secret !== undefined && (
        <SecretModal
          secret={secret}
          onClose={() => {
            setSecret(undefined);
          }}
        />
      )}
    </Card>
  );
}
