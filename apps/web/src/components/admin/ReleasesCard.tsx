/**
 * Phase 9 — releases d'agent (admin) : liste des bundles publiés (version, taille, sha256, canal),
 * publication d'un bundle universel **signé hors panel** (`tools/signing/sign.mjs` : signature Ed25519
 * base64 à coller), suppression. Les agents se mettent à jour depuis ces bundles (manuel ou auto).
 */
import {
  ActionIcon,
  Button,
  Card,
  FileInput,
  Group,
  Stack,
  Table,
  Text,
  TextInput,
  Textarea,
  Title,
  Tooltip,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { IconTrash, IconUpload } from '@tabler/icons-react';

import { useDeleteRelease, usePublishRelease, useReleases } from '../../api/phase9.js';
import { useT } from '../../i18n/hooks.js';
import { describeError } from '../../lib/errors.js';
import { formatBytes, formatDateTime } from '../../lib/format.js';

export function ReleasesCard() {
  const { t, i18n } = useT();
  const releases = useReleases();
  const publish = usePublishRelease();
  const remove = useDeleteRelease();
  const form = useForm<{ version: string; signature: string; notes: string; file: File | null }>({
    initialValues: { version: '', signature: '', notes: '', file: null },
    validate: {
      version: (v) => (/^\d+\.\d+\.\d+/.test(v.trim()) ? null : t('web:errors.validation')),
      signature: (v) => (v.trim().length > 40 ? null : t('web:errors.validation')),
      file: (v) => (v === null ? t('web:errors.validation') : null),
    },
  });
  const fail = (error: unknown): void => {
    notifications.show({ color: 'red', message: describeError(i18n, error) });
  };
  const confirmRemove = (version: string): void => {
    modals.openConfirmModal({
      title: t('web:releases.delete'),
      children: <Text size="sm">{t('web:releases.deleteConfirm', { version })}</Text>,
      labels: { confirm: t('web:common.delete'), cancel: t('web:common.cancel') },
      confirmProps: { color: 'red' },
      onConfirm: () => {
        remove.mutate(version, { onError: fail });
      },
    });
  };
  const rows = releases.data?.releases ?? [];
  return (
    <Card withBorder radius="md" padding="md" data-testid="releases-card">
      <Stack gap="sm">
        <Title order={2} size="h4">
          {t('web:releases.title')}
        </Title>
        <Text size="sm" c="dimmed">
          {t('web:releases.hint')}
        </Text>
        {rows.length === 0 ? (
          <Text size="sm" c="dimmed">
            {t('web:releases.none')}
          </Text>
        ) : (
          <Table striped withTableBorder data-testid="releases-table">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('web:releases.version')}</Table.Th>
                <Table.Th>{t('web:common.date')}</Table.Th>
                <Table.Th>{t('web:releases.size')}</Table.Th>
                <Table.Th>sha256</Table.Th>
                <Table.Th w={60} />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((r) => (
                <Table.Tr key={r.version} data-testid={`release-${r.version}`}>
                  <Table.Td>
                    <Text size="sm" fw={releases.data?.latest === r.version ? 700 : 400}>
                      {r.version}
                    </Text>
                    {r.notes !== null && r.notes !== '' && (
                      <Text size="xs" c="dimmed">
                        {r.notes}
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td>{formatDateTime(r.releasedAt, i18n.language)}</Table.Td>
                  <Table.Td>{formatBytes(r.size)}</Table.Td>
                  <Table.Td>
                    <Text size="xs" ff="monospace">
                      {r.sha256.slice(0, 16)}…
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Tooltip label={t('web:common.delete')} withArrow>
                      <ActionIcon
                        variant="subtle"
                        color="red"
                        aria-label={t('web:common.delete')}
                        onClick={() => {
                          confirmRemove(r.version);
                        }}
                      >
                        <IconTrash size={16} />
                      </ActionIcon>
                    </Tooltip>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
        <form
          onSubmit={form.onSubmit((values) => {
            if (values.file === null) return;
            publish.mutate(
              {
                version: values.version.trim(),
                signature: values.signature.trim(),
                notes: values.notes.trim(),
                file: values.file,
              },
              {
                onSuccess: (data) => {
                  notifications.show({
                    color: 'teal',
                    message: t('web:releases.published', { version: data.release.version }),
                  });
                  form.reset();
                },
                onError: fail,
              },
            );
          })}
        >
          <Stack gap="xs">
            <Group grow align="flex-start">
              <TextInput
                label={t('web:releases.version')}
                placeholder="0.9.1"
                data-testid="release-version"
                {...form.getInputProps('version')}
              />
              <FileInput
                label={t('web:releases.bundle')}
                placeholder="agent.js"
                accept=".js,.cjs"
                data-testid="release-file"
                {...form.getInputProps('file')}
              />
            </Group>
            <Textarea
              label={t('web:releases.signature')}
              description={t('web:releases.signatureHint')}
              autosize
              minRows={2}
              data-testid="release-signature"
              {...form.getInputProps('signature')}
            />
            <TextInput label={t('web:releases.notes')} {...form.getInputProps('notes')} />
            <Group justify="flex-end">
              <Button
                type="submit"
                size="sm"
                leftSection={<IconUpload size={14} />}
                loading={publish.isPending}
                data-testid="release-publish"
              >
                {t('web:releases.publish')}
              </Button>
            </Group>
          </Stack>
        </form>
      </Stack>
    </Card>
  );
}
