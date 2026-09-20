/**
 * Une liste de serveurs, en cartes ou en tableau — partagée par la vue de flotte, la page d'une
 * machine et le tableau de bord.
 *
 * Les deux présentations montrent la MÊME chose : basculer de l'une à l'autre ne doit jamais
 * faire disparaître une information ni une action. Le tableau en met plus à l'écran, les cartes
 * mettent les boutons sous le pouce. La sélection est optionnelle : seule la vue de flotte porte
 * des actions groupées, et une case à cocher sans action derrière n'aurait aucun sens.
 */
import { Badge, Checkbox, Group, SimpleGrid, Stack, Table, Text } from '@mantine/core';

import type { ServerDto } from '@mmo/protocol/client';

import { useT } from '../i18n/hooks.js';
import { formatMb } from '../lib/format.js';
import type { ListMode } from '../lib/list-view.js';
import { RunStateBadge } from './badges.js';
import { RouterAnchor } from './links.js';
import { ServerCard, serverSubtitle } from './ServerCard.js';

/**
 * En deca de ce nombre de serveurs, une barre de recherche est du bruit : on voit tout.
 */
export const LIST_TOOLBAR_MIN = 4;

export interface ServerSelection {
  selected: Set<string>;
  onToggle: (id: string) => void;
  /** Ne porte que sur les serveurs affichés : sélectionner puis filtrer n'agit pas en douce. */
  onToggleAll: () => void;
  allSelected: boolean;
  someSelected: boolean;
}

export function ServerCollection({
  servers,
  mode,
  emptyLabel,
  machineName,
  groupName,
  selection,
}: {
  servers: readonly ServerDto[];
  mode: ListMode;
  emptyLabel: string;
  /** Omise sur la page d'une machine : la colonne dirait partout la même chose. */
  machineName?: (machineId: string) => string;
  groupName?: (groupId: string | null) => string | undefined;
  selection?: ServerSelection;
}) {
  const { t } = useT();
  if (servers.length === 0) {
    return (
      <Text c="dimmed" data-testid="servers-empty">
        {emptyLabel}
      </Text>
    );
  }

  if (mode === 'cards') {
    return (
      <Stack gap="sm" data-testid="servers-cards">
        {selection !== undefined && (
          <Checkbox
            label={t('web:servers.bulk.selectAll')}
            checked={selection.allSelected}
            indeterminate={selection.someSelected && !selection.allSelected}
            onChange={selection.onToggleAll}
            data-testid="servers-select-all"
          />
        )}
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="sm">
          {servers.map((s) => (
            <ServerCard
              key={s.id}
              server={s}
              {...(selection === undefined
                ? {}
                : {
                    selectable: true,
                    selected: selection.selected.has(s.id),
                    onSelectedChange: () => {
                      selection.onToggle(s.id);
                    },
                  })}
            />
          ))}
        </SimpleGrid>
      </Stack>
    );
  }

  return (
    <Table.ScrollContainer minWidth={machineName === undefined ? 520 : 640}>
      <Table highlightOnHover data-testid="servers-table">
        <Table.Thead>
          <Table.Tr>
            {selection !== undefined && (
              <Table.Th w={40}>
                <Checkbox
                  aria-label={t('web:servers.bulk.selectAll')}
                  checked={selection.allSelected}
                  indeterminate={selection.someSelected && !selection.allSelected}
                  onChange={selection.onToggleAll}
                  data-testid="servers-select-all"
                />
              </Table.Th>
            )}
            <Table.Th>{t('web:servers.columns.name')}</Table.Th>
            {machineName !== undefined && <Table.Th>{t('web:servers.columns.machine')}</Table.Th>}
            <Table.Th>{t('web:servers.columns.state')}</Table.Th>
            <Table.Th>{t('web:servers.columns.ram')}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {servers.map((s) => (
            <Table.Tr key={s.id} data-testid={`servers-row-${s.id}`}>
              {selection !== undefined && (
                <Table.Td>
                  <Checkbox
                    aria-label={s.name}
                    checked={selection.selected.has(s.id)}
                    onChange={() => {
                      selection.onToggle(s.id);
                    }}
                    data-testid={`servers-select-${s.id}`}
                  />
                </Table.Td>
              )}
              <Table.Td>
                <Stack gap={0}>
                  <Group gap={6} wrap="nowrap">
                    <RouterAnchor
                      to="/servers/$serverId"
                      params={{ serverId: s.id }}
                      fw={600}
                      truncate="end"
                    >
                      {s.name}
                    </RouterAnchor>
                    <GroupBadge server={s} groupName={groupName} />
                  </Group>
                  <Text size="xs" c="dimmed" truncate="end">
                    {serverSubtitle(s, t(`common:loader.${s.loader}`))}
                  </Text>
                </Stack>
              </Table.Td>
              {machineName !== undefined && (
                <Table.Td>
                  <Text size="sm" truncate="end">
                    {machineName(s.machineId)}
                  </Text>
                </Table.Td>
              )}
              <Table.Td>
                <RunStateBadge server={s} />
              </Table.Td>
              <Table.Td>
                <Text size="sm">{formatMb(s.maxRamMb)}</Text>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

function GroupBadge({
  server,
  groupName,
}: {
  server: ServerDto;
  // Non optionnelle mais nullable : la prop traverse un composant qui peut ne pas l en donner.
  groupName: ((groupId: string | null) => string | undefined) | undefined;
}) {
  const label = groupName?.(server.groupId);
  if (label === undefined) return null;
  return (
    <Badge variant="outline" size="xs" data-testid={`servers-group-badge-${server.id}`}>
      {label}
    </Badge>
  );
}
