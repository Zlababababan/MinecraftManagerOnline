/**
 * Lot 5 — créer un serveur depuis une archive (doc 06 §6sexies) : l'utilisateur a téléchargé le
 * zip « server files » d'un modpack. Il le désigne, on en lit le contenu (rien n'est déplié), et on
 * dit ce que le panel va faire : quel chargeur, pour quelle version de jeu.
 *
 * Deux façons de le désigner (retour de Yassin, 02/10 : devoir déplacer le zip dans un répertoire
 * surveillé puis le retrouver dans une liste était un détour) :
 * - **coller son chemin** sur la machine, où qu'il soit (administrateur) — c'est la voie directe,
 *   elle vient en premier ;
 * - le choisir dans la liste des zips déjà posés à la racine d'un répertoire surveillé.
 *
 * Aucune interrogation périodique : la liste se relit au bouton « Actualiser ».
 */
import { Alert, Button, Group, NativeSelect, Stack, Text, TextInput } from '@mantine/core';
import { IconAlertTriangle, IconRefresh } from '@tabler/icons-react';
import { useState } from 'react';

import type {
  InstallArchiveDto,
  InstallArchiveInspectionDto,
  MachineDto,
} from '@mmo/protocol/client';

import { useInspectArchive, useInstallArchives } from '../../api/installs.js';
import { useMe } from '../../api/queries.js';
import { useT } from '../../i18n/hooks.js';
import { formatBytes, hasRole } from '../../lib/format.js';
import { TECHNICAL_INPUT_PROPS } from '../../lib/inputs.js';
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

/**
 * Le chemin tel qu'on le colle : Windows (« Copier en tant que chemin ») l'entoure de guillemets,
 * et un copier-coller traîne volontiers des espaces.
 */
export function cleanPastedPath(raw: string): string {
  return raw
    .trim()
    .replace(/^["']+|["']+$/g, '')
    .trim();
}

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
  const me = useMe();
  const archives = useInstallArchives(machineId, true);
  const inspect = useInspectArchive(machineId);
  const [typed, setTyped] = useState('');
  const list = archives.data?.archives ?? [];
  // Un chemin libre sur la machine est un geste d'administrateur (le panel le vérifie aussi).
  const canTypePath = me.data !== undefined && hasRole(me.data.user.role, 'admin');

  const use = (archive: InstallArchiveDto) => {
    onChange(undefined);
    inspect.reset();
    inspect.mutate(archive.path, {
      onSuccess: (data) => {
        onChange({ archive, inspection: data.inspection });
      },
    });
  };
  const choose = (path: string) => {
    const archive = list.find((a) => a.path === path);
    if (archive === undefined) {
      onChange(undefined);
      inspect.reset();
      return;
    }
    setTyped('');
    use(archive);
  };
  const usePath = () => {
    const path = cleanPastedPath(typed);
    if (path === '') return;
    setTyped(path);
    // Un zip de la liste, collé à la main : c'est le même.
    const known = list.find((a) => a.path === path);
    use(
      known ?? {
        directoryId: '',
        name: path.split(/[\\/]/).pop() ?? path,
        path,
        size: 0,
        modifiedAt: 0,
      },
    );
  };

  const recognized = value?.inspection.recognized ?? null;
  const properties = Object.entries(value?.inspection.properties ?? {});
  const fromList = value !== undefined && list.some((a) => a.path === value.archive.path);
  return (
    <Stack gap="xs" data-testid="archive-picker">
      {canTypePath && (
        <Group align="flex-end" wrap="nowrap" gap="xs">
          <TextInput
            style={{ flex: 1 }}
            label={t('web:install.archive.path')}
            description={t('web:install.archive.pathHint')}
            placeholder={t('web:install.archive.pathPlaceholder')}
            value={typed}
            disabled={inspect.isPending}
            {...TECHNICAL_INPUT_PROPS}
            data-testid="archive-path"
            onChange={(e) => {
              setTyped(e.currentTarget.value);
            }}
            onKeyDown={(e) => {
              // Entrée valide le chemin, pas l'étape de l'assistant.
              if (e.key === 'Enter') {
                e.preventDefault();
                usePath();
              }
            }}
          />
          <Button
            variant="default"
            loading={inspect.isPending}
            disabled={cleanPastedPath(typed) === ''}
            data-testid="archive-path-use"
            onClick={usePath}
          >
            {t('web:install.archive.pathUse')}
          </Button>
        </Group>
      )}
      <Group align="flex-end" wrap="nowrap" gap="xs">
        <NativeSelect
          style={{ flex: 1 }}
          label={canTypePath ? t('web:install.archive.selectOr') : t('web:install.archive.select')}
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
          value={fromList ? value.archive.path : ''}
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
      <Text size="xs" c="dimmed" data-testid="archive-directories">
        {t('web:install.archive.where', { list: directories.map((d) => d.path).join(' · ') })}
      </Text>
      {error !== undefined && (
        <Text size="sm" c="red" data-testid="archive-required">
          {error}
        </Text>
      )}
      {inspect.isPending && <Text size="sm">{t('web:install.archive.reading')}</Text>}
      <ErrorAlert error={archives.error} />
      <ErrorAlert error={inspect.error} />
      {value !== undefined && (
        <Stack gap={4} data-testid="archive-summary">
          <Text size="sm" fw={600} style={{ wordBreak: 'break-all' }}>
            {value.archive.name}
          </Text>
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
