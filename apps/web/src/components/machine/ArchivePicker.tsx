/**
 * Lot 5 — créer un serveur depuis une archive (doc 06 §6sexies) : l'utilisateur a téléchargé le
 * zip « server files » d'un modpack dans son navigateur et l'a posé dans un répertoire surveillé de
 * la machine. On liste ces zips, on en lit le contenu (rien n'est déplié), et on dit ce que le
 * panel va faire : quel chargeur, pour quelle version de jeu.
 *
 * Aucune interrogation périodique : la liste se relit au bouton « Actualiser ».
 */
import { Alert, Button, Group, List, NativeSelect, Stack, Text } from '@mantine/core';
import { IconAlertTriangle, IconRefresh } from '@tabler/icons-react';

import type {
  InstallArchiveDto,
  InstallArchiveInspectionDto,
  MachineDto,
} from '@mmo/protocol/client';

import { useInspectArchive, useInstallArchives } from '../../api/installs.js';
import { useT } from '../../i18n/hooks.js';
import { formatBytes } from '../../lib/format.js';
import { ErrorAlert } from '../ErrorAlert.js';

export interface ArchiveSelection {
  archive: InstallArchiveDto;
  inspection: InstallArchiveInspectionDto;
}

const LOADER_NAMES = {
  vanilla: 'Minecraft',
  fabric: 'Fabric',
  forge: 'Forge',
  neoforge: 'NeoForge',
} as const;

export function ArchivePicker({
  machineId,
  directories,
  value,
  onChange,
  error,
}: {
  machineId: string;
  directories: MachineDto['watchedDirectories'];
  value: ArchiveSelection | undefined;
  onChange: (selection: ArchiveSelection | undefined) => void;
  error?: string | undefined;
}) {
  const { t } = useT();
  const archives = useInstallArchives(machineId, true);
  const inspect = useInspectArchive(machineId);
  const list = archives.data?.archives ?? [];

  const choose = (path: string) => {
    onChange(undefined);
    inspect.reset();
    const archive = list.find((a) => a.path === path);
    if (archive === undefined) return;
    inspect.mutate(archive.path, {
      onSuccess: (data) => {
        onChange({ archive, inspection: data.inspection });
      },
    });
  };

  const recognized = value?.inspection.recognized ?? null;
  const properties = Object.entries(value?.inspection.properties ?? {});
  return (
    <Stack gap="xs" data-testid="archive-picker">
      <Text size="sm">{t('web:install.archive.where')}</Text>
      <List size="sm" ff="monospace" data-testid="archive-directories">
        {directories.map((d) => (
          <List.Item key={d.id}>{d.path}</List.Item>
        ))}
      </List>
      <Group align="flex-end" wrap="nowrap">
        <NativeSelect
          style={{ flex: 1 }}
          label={t('web:install.archive.select')}
          disabled={archives.isPending || inspect.isPending}
          data={[
            {
              value: '',
              label: archives.isPending
                ? t('web:common.loading')
                : list.length === 0
                  ? t('web:install.archive.none')
                  : '—',
            },
            ...list.map((a) => ({ value: a.path, label: `${a.name} — ${formatBytes(a.size)}` })),
          ]}
          value={value?.archive.path ?? (inspect.isPending ? inspect.variables : '')}
          error={error}
          data-testid="archive-select"
          onChange={(e) => {
            choose(e.currentTarget.value);
          }}
        />
        <Button
          variant="default"
          leftSection={<IconRefresh size={14} />}
          loading={archives.isFetching}
          data-testid="archive-refresh"
          onClick={() => {
            void archives.refetch();
          }}
        >
          {t('web:install.archive.refresh')}
        </Button>
      </Group>
      {inspect.isPending && <Text size="sm">{t('web:install.archive.reading')}</Text>}
      <ErrorAlert error={archives.error} />
      <ErrorAlert error={inspect.error} />
      {value !== undefined && (
        <Stack gap={4} data-testid="archive-summary">
          <Text size="sm">
            {t('web:install.archive.content', {
              files: value.inspection.files,
              size: formatBytes(value.inspection.bytes),
            })}
          </Text>
          {recognized !== null && (
            <Text size="sm" data-testid="archive-recognized">
              {t('web:install.archive.recognized', {
                loader: LOADER_NAMES[recognized.loader],
                loaderVersion: recognized.loaderVersion,
                mcVersion: recognized.mcVersion,
                source: recognized.source,
              })}
            </Text>
          )}
          {recognized !== null && properties.length > 0 && (
            <Text size="sm" c="dimmed" data-testid="archive-properties">
              {t('web:install.archive.properties', {
                list: properties.map(([k, v]) => `${k}=${v}`).join(', '),
              })}
            </Text>
          )}
          {recognized === null && (
            <Alert
              color="orange"
              icon={<IconAlertTriangle size={16} />}
              data-testid="archive-unrecognized"
            >
              {t('web:install.archive.unrecognized')}
            </Alert>
          )}
        </Stack>
      )}
      <Text size="xs" c="dimmed">
        {t('web:install.archive.hint')}
      </Text>
    </Stack>
  );
}
