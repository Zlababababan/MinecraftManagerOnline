/**
 * Barre commune à toutes les listes : recherche, filtres propres à la page, tri, commutateur
 * cartes/tableau, bouton d'effacement.
 *
 * Une seule barre pour toutes les pages, parce qu'avec cinquante serveurs on cherche de la même
 * façon partout : le champ toujours à gauche, les filtres au milieu, l'affichage à droite. Les
 * filtres eux-mêmes restent à la page (ils n'ont rien de commun : loader ici, sévérité ailleurs)
 * et arrivent en `filters` ; ce qui est commun, c'est la disposition et les gestes.
 */
import { Button, Group, SegmentedControl, Select, TextInput } from '@mantine/core';
import { IconLayoutGrid, IconSearch, IconTable, IconX } from '@tabler/icons-react';

import type { ReactNode } from 'react';

import { useT } from '../i18n/hooks.js';
import { TECHNICAL_INPUT_PROPS } from '../lib/inputs.js';
import { isListMode, type ListMode } from '../lib/list-view.js';

export interface ListSortProps {
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  testId?: string;
}

export interface ListToolbarProps {
  search: string;
  onSearch: (value: string) => void;
  searchLabel: string;
  searchPlaceholder?: string;
  searchTestId?: string;
  /** Les Select propres à la page, déjà étiquetés. */
  filters?: ReactNode;
  sort?: ListSortProps;
  /** Omis quand la liste n'a qu'une seule présentation possible. */
  mode?: ListMode;
  onModeChange?: (mode: ListMode) => void;
  modeTestId?: string;
  onReset?: () => void;
  resetDisabled?: boolean;
  resetTestId?: string;
}

export function ListToolbar({
  search,
  onSearch,
  searchLabel,
  searchPlaceholder,
  searchTestId,
  filters,
  sort,
  mode,
  onModeChange,
  modeTestId,
  onReset,
  resetDisabled,
  resetTestId,
}: ListToolbarProps) {
  const { t } = useT();
  return (
    <Group gap="xs" wrap="wrap" align="flex-end" data-testid="list-toolbar">
      <TextInput
        label={searchLabel}
        placeholder={searchPlaceholder ?? ''}
        value={search}
        onChange={(e) => {
          onSearch(e.currentTarget.value);
        }}
        leftSection={<IconSearch size={16} />}
        {...TECHNICAL_INPUT_PROPS}
        {...(searchTestId === undefined ? {} : { 'data-testid': searchTestId })}
        style={{ flex: '1 1 220px' }}
      />
      {filters}
      {sort !== undefined && (
        <Select
          label={t('web:list.sort')}
          value={sort.value}
          onChange={(v) => {
            if (v !== null) sort.onChange(v);
          }}
          data={sort.options}
          allowDeselect={false}
          {...(sort.testId === undefined ? {} : { 'data-testid': sort.testId })}
          style={{ flex: '0 1 170px' }}
        />
      )}
      {mode !== undefined && onModeChange !== undefined && (
        <SegmentedControl
          value={mode}
          onChange={(v) => {
            // Le contrôle rend `string` : on n'accepte que les modes connus.
            if (isListMode(v)) onModeChange(v);
          }}
          data={[
            {
              value: 'cards',
              label: (
                <Group gap={6} wrap="nowrap">
                  <IconLayoutGrid size={14} />
                  {t('web:list.view.cards')}
                </Group>
              ),
            },
            {
              value: 'table',
              label: (
                <Group gap={6} wrap="nowrap">
                  <IconTable size={14} />
                  {t('web:list.view.table')}
                </Group>
              ),
            },
          ]}
          {...(modeTestId === undefined ? {} : { 'data-testid': modeTestId })}
        />
      )}
      {onReset !== undefined && (
        <Button
          variant="default"
          leftSection={<IconX size={16} />}
          onClick={onReset}
          disabled={resetDisabled ?? false}
          {...(resetTestId === undefined ? {} : { 'data-testid': resetTestId })}
        >
          {t('web:list.reset')}
        </Button>
      )}
    </Group>
  );
}
