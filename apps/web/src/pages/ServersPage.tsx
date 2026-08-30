/**
 * Liste plate de TOUS les serveurs : recherche, filtres, tri, sélection et actions groupées.
 *
 * Le tableau de bord groupe les serveurs par machine, ce qui va très bien à trois serveurs et
 * beaucoup moins à cinquante : il fallait une vue où l'on cherche « atm10 » et où l'on démarre
 * quatre serveurs d'un coup. L'état du filtre vit dans l'URL — une vue se met en favori et se
 * partage.
 */
import {
  Alert,
  Button,
  Checkbox,
  Group,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconPlayerPlay,
  IconPlayerStop,
  IconRefresh,
  IconSearch,
  IconX,
} from '@tabler/icons-react';
import { useState } from 'react';

import type { BulkActionResult, ServerDto } from '@mmo/protocol/client';

import { useBulkAction, useMachines, useMe, useServers } from '../api/queries.js';
import { RunStateBadge } from '../components/badges.js';
import { RouterAnchor } from '../components/links.js';
import { serverSubtitle } from '../components/ServerCard.js';
import { useT } from '../i18n/hooks.js';
import { TECHNICAL_INPUT_PROPS } from '../lib/inputs.js';
import { formatMb, hasRole } from '../lib/format.js';
import {
  EMPTY_FILTER,
  filterOptions,
  filterServers,
  isServerSort,
  type ServerFilter,
} from '../lib/server-filter.js';

export function ServersPage({
  filter,
  onFilterChange,
}: {
  filter: ServerFilter;
  onFilterChange: (next: ServerFilter) => void;
}) {
  const { t } = useT();
  const me = useMe();
  const servers = useServers();
  const machines = useMachines();
  const bulk = useBulkAction();
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const canOperate = me.data !== undefined && hasRole(me.data.user.role, 'operator');
  const all = servers.data?.servers ?? [];
  const options = filterOptions(all);
  const shown = filterServers(all, filter);
  const machineName = (id: string) => machines.data?.machines.find((m) => m.id === id)?.name ?? id;

  const set = (patch: Partial<ServerFilter>) => {
    onFilterChange({ ...filter, ...patch });
  };
  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  // La sélection ne porte que sur ce qui est visible : sélectionner puis filtrer ne doit pas
  // agir en douce sur des serveurs sortis de l'écran.
  const visibleSelected = shown.filter((s) => selected.has(s.id));
  const allVisibleSelected = shown.length > 0 && visibleSelected.length === shown.length;

  const run = (action: 'start' | 'stop' | 'restart') => {
    bulk.mutate(
      { action, serverIds: visibleSelected.map((s) => s.id) },
      {
        onSuccess: () => {
          setSelected(new Set());
        },
      },
    );
  };

  const filtered = shown.length !== all.length;

  return (
    <Stack gap="md" data-testid="servers-page">
      <Group justify="space-between" wrap="wrap">
        <Title order={2}>{t('web:servers.title')}</Title>
        <Text size="sm" c="dimmed" data-testid="servers-count">
          {filtered
            ? t('web:servers.countFiltered', { shown: shown.length, total: all.length })
            : t('web:servers.count', { count: all.length })}
        </Text>
      </Group>

      <Group gap="xs" wrap="wrap" align="flex-end">
        <TextInput
          label={t('web:servers.search')}
          placeholder={t('web:servers.searchPlaceholder')}
          value={filter.q}
          onChange={(e) => {
            set({ q: e.currentTarget.value });
          }}
          leftSection={<IconSearch size={16} />}
          {...TECHNICAL_INPUT_PROPS}
          data-testid="servers-search"
          style={{ flex: '1 1 220px' }}
        />
        <Select
          label={t('web:servers.filters.machine')}
          placeholder={t('web:servers.filters.any')}
          value={filter.machineId ?? null}
          onChange={(v) => {
            set({ machineId: v ?? undefined });
          }}
          data={(machines.data?.machines ?? []).map((m) => ({ value: m.id, label: m.name }))}
          clearable
          data-testid="servers-filter-machine"
          style={{ flex: '0 1 170px' }}
        />
        <Select
          label={t('web:servers.filters.loader')}
          placeholder={t('web:servers.filters.any')}
          value={filter.loader ?? null}
          onChange={(v) => {
            // Le Select rend `string | null` : on ne retient que les valeurs réellement présentes.
            set({ loader: options.loaders.find((l) => l === v) });
          }}
          data={options.loaders.map((l) => ({ value: l, label: t(`common:loader.${l}`) }))}
          clearable
          data-testid="servers-filter-loader"
          style={{ flex: '0 1 150px' }}
        />
        <Select
          label={t('web:servers.filters.version')}
          placeholder={t('web:servers.filters.any')}
          value={filter.mcVersion ?? null}
          onChange={(v) => {
            set({ mcVersion: v ?? undefined });
          }}
          data={options.mcVersions}
          clearable
          searchable
          data-testid="servers-filter-version"
          style={{ flex: '0 1 130px' }}
        />
        <Select
          label={t('web:servers.filters.state')}
          placeholder={t('web:servers.filters.any')}
          value={filter.runState ?? null}
          onChange={(v) => {
            set({ runState: options.runStates.find((s) => s === v) });
          }}
          data={options.runStates.map((s) => ({ value: s, label: t(`common:runState.${s}`) }))}
          clearable
          data-testid="servers-filter-state"
          style={{ flex: '0 1 150px' }}
        />
        <Select
          label={t('web:servers.sort.label')}
          value={filter.sort}
          onChange={(v) => {
            if (isServerSort(v)) set({ sort: v });
          }}
          data={[
            { value: 'name', label: t('web:servers.sort.name') },
            { value: 'state', label: t('web:servers.sort.state') },
            { value: 'started', label: t('web:servers.sort.started') },
            { value: 'ram', label: t('web:servers.sort.ram') },
          ]}
          allowDeselect={false}
          data-testid="servers-sort"
          style={{ flex: '0 1 170px' }}
        />
        <Button
          variant="default"
          leftSection={<IconX size={16} />}
          onClick={() => {
            onFilterChange(EMPTY_FILTER);
          }}
          disabled={!filtered && filter.q === '' && filter.sort === 'name'}
          data-testid="servers-filter-reset"
        >
          {t('web:servers.filters.reset')}
        </Button>
      </Group>

      {canOperate && visibleSelected.length > 0 && (
        <Group
          gap="xs"
          p="xs"
          wrap="wrap"
          style={{ border: '1px solid var(--mantine-color-default-border)', borderRadius: 8 }}
          data-testid="servers-bulk-bar"
        >
          <Text size="sm" fw={600}>
            {t('web:servers.bulk.selected', { count: visibleSelected.length })}
          </Text>
          <Button
            size="xs"
            leftSection={<IconPlayerPlay size={14} />}
            loading={bulk.isPending}
            onClick={() => {
              run('start');
            }}
            data-testid="servers-bulk-start"
          >
            {t('web:server.actions.start')}
          </Button>
          <Button
            size="xs"
            variant="default"
            leftSection={<IconPlayerStop size={14} />}
            loading={bulk.isPending}
            onClick={() => {
              run('stop');
            }}
            data-testid="servers-bulk-stop"
          >
            {t('web:server.actions.stop')}
          </Button>
          <Button
            size="xs"
            variant="default"
            leftSection={<IconRefresh size={14} />}
            loading={bulk.isPending}
            onClick={() => {
              run('restart');
            }}
            data-testid="servers-bulk-restart"
          >
            {t('web:server.actions.restart')}
          </Button>
          <Text size="xs" c="dimmed">
            {t('web:servers.bulk.sequential')}
          </Text>
        </Group>
      )}

      {bulk.data !== undefined && <BulkReport results={bulk.data.results} />}

      {shown.length === 0 ? (
        <Text c="dimmed" data-testid="servers-empty">
          {all.length === 0 ? t('web:servers.none') : t('web:servers.noMatch')}
        </Text>
      ) : (
        <Table.ScrollContainer minWidth={640}>
          <Table highlightOnHover data-testid="servers-table">
            <Table.Thead>
              <Table.Tr>
                {canOperate && (
                  <Table.Th w={40}>
                    <Checkbox
                      aria-label={t('web:servers.bulk.selectAll')}
                      checked={allVisibleSelected}
                      indeterminate={visibleSelected.length > 0 && !allVisibleSelected}
                      onChange={() => {
                        setSelected(
                          allVisibleSelected ? new Set() : new Set(shown.map((s) => s.id)),
                        );
                      }}
                      data-testid="servers-select-all"
                    />
                  </Table.Th>
                )}
                <Table.Th>{t('web:servers.columns.name')}</Table.Th>
                <Table.Th>{t('web:servers.columns.machine')}</Table.Th>
                <Table.Th>{t('web:servers.columns.state')}</Table.Th>
                <Table.Th>{t('web:servers.columns.ram')}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {shown.map((s) => (
                <ServerRow
                  key={s.id}
                  server={s}
                  machineName={machineName(s.machineId)}
                  loaderLabel={t(`common:loader.${s.loader}`)}
                  selectable={canOperate}
                  selected={selected.has(s.id)}
                  onToggle={() => {
                    toggle(s.id);
                  }}
                  ramLabel={formatMb(s.maxRamMb)}
                />
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
    </Stack>
  );
}

function ServerRow({
  server,
  machineName,
  loaderLabel,
  selectable,
  selected,
  onToggle,
  ramLabel,
}: {
  server: ServerDto;
  machineName: string;
  loaderLabel: string;
  selectable: boolean;
  selected: boolean;
  onToggle: () => void;
  ramLabel: string;
}) {
  return (
    <Table.Tr data-testid={`servers-row-${server.id}`}>
      {selectable && (
        <Table.Td>
          <Checkbox
            aria-label={server.name}
            checked={selected}
            onChange={onToggle}
            data-testid={`servers-select-${server.id}`}
          />
        </Table.Td>
      )}
      <Table.Td>
        <Stack gap={0}>
          <RouterAnchor
            to="/servers/$serverId"
            params={{ serverId: server.id }}
            fw={600}
            truncate="end"
          >
            {server.name}
          </RouterAnchor>
          <Text size="xs" c="dimmed" truncate="end">
            {serverSubtitle(server, loaderLabel)}
          </Text>
        </Stack>
      </Table.Td>
      <Table.Td>
        <Text size="sm" truncate="end">
          {machineName}
        </Text>
      </Table.Td>
      <Table.Td>
        <RunStateBadge server={server} />
      </Table.Td>
      <Table.Td>
        <Text size="sm">{ramLabel}</Text>
      </Table.Td>
    </Table.Tr>
  );
}

/**
 * Résultat d'une action groupée. L'exécution s'arrête au premier refus : il faut donc dire
 * lequel a bloqué et pourquoi, et lesquels n'ont pas été tentés — sinon l'utilisateur croit à un
 * échec global.
 */
function BulkReport({ results }: { results: BulkActionResult['results'] }) {
  const { t } = useT();
  const failed = results.filter((r) => r.status === 'failed');
  const skipped = results.filter((r) => r.status === 'skipped');
  const done = results.filter((r) => r.status === 'done');
  return (
    <Alert
      color={failed.length > 0 ? 'red' : 'teal'}
      icon={failed.length > 0 ? <IconAlertTriangle size={18} /> : undefined}
      data-testid="servers-bulk-report"
    >
      <Stack gap={4}>
        <Text size="sm">{t('web:servers.bulk.done', { count: done.length })}</Text>
        {failed.map((r) => (
          <Text size="sm" key={r.serverId} data-testid={`servers-bulk-failed-${r.serverId}`}>
            {r.name} — {r.error?.message ?? ''}
          </Text>
        ))}
        {skipped.length > 0 && (
          <Text size="sm" c="dimmed">
            {t('web:servers.bulk.skipped', {
              count: skipped.length,
              names: skipped.map((r) => r.name).join(', '),
            })}
          </Text>
        )}
      </Stack>
    </Alert>
  );
}
