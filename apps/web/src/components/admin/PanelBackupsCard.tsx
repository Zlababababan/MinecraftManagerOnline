/**
 * Phase 12 — sauvegardes du panel lui-même (admin) : copies `VACUUM INTO` listées (fichier, taille,
 * date), sauvegarde à la demande, dossier et commande de restauration (`mmo-panel restore <fichier>`,
 * panel arrêté — la restauration ne se fait pas depuis l'interface).
 */
import { Button, Card, Code, Group, Stack, Table, Text, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconDatabaseExport } from '@tabler/icons-react';

import { panelBackupsQuery, usePanelBackupNow } from '../../api/phase8.js';
import { useT } from '../../i18n/hooks.js';
import { describeError } from '../../lib/errors.js';
import { formatBytes, formatDateTime } from '../../lib/format.js';
import { useQuery } from '@tanstack/react-query';

export function PanelBackupsCard() {
  const { t, i18n } = useT();
  const backups = useQuery(panelBackupsQuery);
  const backupNow = usePanelBackupNow();
  const rows = backups.data?.backups ?? [];
  return (
    <Card withBorder radius="md" padding="md" data-testid="panel-backups-card">
      <Stack gap="sm">
        <Group justify="space-between" align="flex-start">
          <Title order={2} size="h4">
            {t('web:panelBackups.title')}
          </Title>
          <Button
            type="button"
            size="xs"
            leftSection={<IconDatabaseExport size={16} aria-hidden />}
            loading={backupNow.isPending}
            data-testid="panel-backup-now"
            onClick={() => {
              backupNow.mutate(undefined, {
                onSuccess: ({ backup }) => {
                  notifications.show({
                    color: 'green',
                    message: t('web:panelBackups.created', { file: backup.file }),
                  });
                },
                onError: (error) => {
                  notifications.show({ color: 'red', message: describeError(i18n, error) });
                },
              });
            }}
          >
            {t('web:panelBackups.now')}
          </Button>
        </Group>
        <Text size="sm" c="dimmed">
          {t('web:panelBackups.hint')}
        </Text>
        {backups.data !== undefined && (
          <Text size="xs" c="dimmed">
            {t('web:panelBackups.directory')} : <Code>{backups.data.directory}</Code>
          </Text>
        )}
        {rows.length === 0 ? (
          <Text size="sm" c="dimmed">
            {t('web:panelBackups.none')}
          </Text>
        ) : (
          <Table striped withTableBorder data-testid="panel-backups-table">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('web:panelBackups.file')}</Table.Th>
                <Table.Th>{t('web:common.date')}</Table.Th>
                <Table.Th>{t('web:panelBackups.size')}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((b) => (
                <Table.Tr key={b.file}>
                  <Table.Td>
                    <Code>{b.file}</Code>
                  </Table.Td>
                  <Table.Td>{formatDateTime(b.createdAt, i18n.language)}</Table.Td>
                  <Table.Td>{formatBytes(b.sizeBytes)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
        <Text size="xs" c="dimmed">
          {t('web:panelBackups.restoreHint')}{' '}
          <Code>mmo-panel restore {rows[0]?.file ?? 'mmo-<date>.db'}</Code>
        </Text>
      </Stack>
    </Card>
  );
}
