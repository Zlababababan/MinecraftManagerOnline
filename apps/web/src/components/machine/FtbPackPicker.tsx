/**
 * Intégration FTB (lot 5) — choisir un modpack FTB et sa version dans l'assistant de création.
 * **Retirable** avec le reste de l'intégration (docs/services-tiers.md).
 *
 * Sans recherche, la liste montre les packs les plus installés ; une recherche par nom la remplace.
 * Les versions dont le panel ne sait pas installer le chargeur sont montrées mais inactives, pour
 * qu'on comprenne pourquoi elles manquent.
 */
import { Button, Group, NativeSelect, Stack, Text, TextInput } from '@mantine/core';
import { IconSearch } from '@tabler/icons-react';
import { useState } from 'react';

import type { FtbPackSummaryDto, FtbVersionDto } from '@mmo/protocol/client';

import { useFtbPack, useFtbPacks } from '../../api/ftb.js';
import { useT } from '../../i18n/hooks.js';
import { ErrorAlert } from '../ErrorAlert.js';
import { ThirdPartyNote } from '../ThirdPartyNote.js';

export interface FtbSelection {
  pack: FtbPackSummaryDto;
  version: FtbVersionDto;
}

const LOADER_NAMES = { forge: 'Forge', neoforge: 'NeoForge', fabric: 'Fabric' } as const;

export function FtbPackPicker({
  value,
  onChange,
  error,
}: {
  value: FtbSelection | undefined;
  onChange: (selection: FtbSelection | undefined) => void;
  error?: string | undefined;
}) {
  const { t } = useT();
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [packId, setPackId] = useState<number | undefined>(value?.pack.id);
  const packs = useFtbPacks(query, true);
  const pack = useFtbPack(packId);

  const describe = (v: FtbVersionDto): string => {
    const parts = [v.name];
    if (v.mcVersion !== null) parts.push(`Minecraft ${v.mcVersion}`);
    if (v.loader !== null) parts.push(`${LOADER_NAMES[v.loader]} ${v.loaderVersion ?? ''}`.trim());
    if (v.type !== 'release') parts.push(`(${v.type})`);
    return parts.join(' · ');
  };

  const choosePack = (id: number | undefined) => {
    setPackId(id);
    onChange(undefined);
  };

  const list = packs.data?.packs ?? [];
  return (
    <Stack gap="xs" data-testid="ftb-picker">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(draft.trim());
          choosePack(undefined);
        }}
      >
        <Group gap="xs" align="flex-end" wrap="nowrap">
          <TextInput
            style={{ flex: 1 }}
            label={t('web:install.ftb.search')}
            placeholder={t('web:install.ftb.searchPlaceholder')}
            value={draft}
            data-testid="ftb-search"
            onChange={(e) => {
              setDraft(e.currentTarget.value);
            }}
          />
          <Button type="submit" variant="light" leftSection={<IconSearch size={14} />}>
            {t('web:install.ftb.searchButton')}
          </Button>
        </Group>
      </form>
      <NativeSelect
        label={query === '' ? t('web:install.ftb.popular') : t('web:install.ftb.results')}
        disabled={packs.isPending}
        data={[
          {
            value: '',
            label: packs.isPending
              ? t('web:common.loading')
              : list.length === 0
                ? t('web:install.ftb.noResult')
                : '—',
          },
          ...list.map((p) => ({ value: String(p.id), label: p.name })),
        ]}
        value={packId === undefined ? '' : String(packId)}
        data-testid="ftb-pack"
        onChange={(e) => {
          const raw = e.currentTarget.value;
          choosePack(raw === '' ? undefined : Number(raw));
        }}
      />
      {pack.data !== undefined && pack.data.pack.synopsis !== '' && (
        <Text size="xs" c="dimmed">
          {pack.data.pack.synopsis}
        </Text>
      )}
      {packId !== undefined && (
        <NativeSelect
          label={t('web:install.ftb.version')}
          disabled={pack.isPending}
          error={error}
          data={[
            { value: '', label: pack.isPending ? t('web:common.loading') : '—' },
            ...(pack.data?.pack.versions ?? []).map((v) => ({
              value: String(v.id),
              label: v.installable
                ? describe(v)
                : `${describe(v)} — ${t('web:install.ftb.notInstallable')}`,
              disabled: !v.installable,
            })),
          ]}
          value={value === undefined ? '' : String(value.version.id)}
          data-testid="ftb-version"
          onChange={(e) => {
            const id = Number(e.currentTarget.value);
            const p = pack.data?.pack;
            const version = p?.versions.find((v) => v.id === id);
            onChange(
              p === undefined || version === undefined
                ? undefined
                : { pack: { id: p.id, name: p.name, synopsis: p.synopsis }, version },
            );
          }}
        />
      )}
      {packId === undefined && error !== undefined && (
        <Text size="xs" c="red">
          {error}
        </Text>
      )}
      <ErrorAlert error={packs.error ?? pack.error} />
      <Text size="xs" c="dimmed">
        {t('web:install.ftb.hint')}
      </Text>
      <ThirdPartyNote services={['ftb', 'curseforge']} />
    </Stack>
  );
}
