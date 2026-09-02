/**
 * Phase 12 — sauvegardes du panel lui-même (admin) : archives listées (fichier, date, taille,
 * contenu), sauvegarde à la demande, dossier et commande de restauration (`mmo-panel restore
 * <fichier>`, panel arrêté — la restauration ne se fait pas depuis l'interface).
 *
 * Lot 4 (2026-09-02) : l'archive `.tar.gz` emporte la base ET le dossier `tls/` ; elle se
 * **télécharge** ici (admin), précédée de l'avertissement qui compte — elle contient les secrets
 * du panel ; et l'échec de la dernière sauvegarde automatique s'affiche en rouge au lieu de
 * dormir dans un journal.
 */
import { Alert, Button, Card, Code, Group, Stack, Table, Text, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle, IconDatabaseExport, IconDownload } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { api } from '../../api/client.js';
import { panelBackupsQuery, usePanelBackupNow } from '../../api/phase8.js';
import { useT } from '../../i18n/hooks.js';
import { describeError } from '../../lib/errors.js';
import { formatBytes, formatDateTime } from '../../lib/format.js';

export function PanelBackupsCard() {
  const { t, i18n } = useT();
  const backups = useQuery(panelBackupsQuery);
  const backupNow = usePanelBackupNow();
  const [downloading, setDownloading] = useState<string | undefined>(undefined);
  const rows = backups.data?.backups ?? [];
  const status = backups.data?.status;
  const download = async (file: string) => {
    setDownloading(file);
    try {
      const { blob, fileName } = await api.download(
        `/api/admin/backups/${encodeURIComponent(file)}/download`,
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      notifications.show({ color: 'red', message: describeError(i18n, error) });
    } finally {
      setDownloading(undefined);
    }
  };
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
        {status?.lastError !== undefined && status.lastError !== null && (
          <Alert
            color="red"
            icon={<IconAlertTriangle size={16} aria-hidden />}
            data-testid="panel-backup-last-error"
          >
            {t('web:panelBackups.lastError', { error: status.lastError })}
          </Alert>
        )}
        <Alert
          color="yellow"
          variant="light"
          icon={<IconAlertTriangle size={16} aria-hidden />}
          data-testid="panel-backup-secrets-warning"
        >
          {t('web:panelBackups.secretsWarning')}
        </Alert>
        {backups.data !== undefined && (
          <Text size="xs" c="dimmed">
            {t('web:panelBackups.directory')} : <Code>{backups.data.directory}</Code>
            {status?.lastSuccessAt !== undefined && status.lastSuccessAt !== null && (
              <>
                {' · '}
                {t('web:panelBackups.lastSuccess', {
                  date: formatDateTime(status.lastSuccessAt, i18n.language),
                })}
              </>
            )}
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
                <Table.Th>{t('web:panelBackups.contents')}</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((b) => (
                <Table.Tr key={b.file} data-testid={`panel-backup-${b.file}`}>
                  <Table.Td>
                    <Code>{b.file}</Code>
                  </Table.Td>
                  <Table.Td>{formatDateTime(b.createdAt, i18n.language)}</Table.Td>
                  <Table.Td>{formatBytes(b.sizeBytes)}</Table.Td>
                  <Table.Td>{t(`web:panelBackups.formats.${b.format}`)}</Table.Td>
                  <Table.Td>
                    <Button
                      type="button"
                      size="compact-xs"
                      variant="subtle"
                      leftSection={<IconDownload size={14} aria-hidden />}
                      loading={downloading === b.file}
                      data-testid={`panel-backup-download-${b.file}`}
                      onClick={() => {
                        void download(b.file);
                      }}
                    >
                      {t('web:panelBackups.download')}
                    </Button>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
        <Text size="xs" c="dimmed">
          {t('web:panelBackups.restoreHint')}{' '}
          <Code>mmo-panel restore {rows[0]?.file ?? 'mmo-panel-<date>.tar.gz'}</Code>
        </Text>
      </Stack>
    </Card>
  );
}
