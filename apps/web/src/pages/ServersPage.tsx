/**
 * Liste plate de TOUS les serveurs : recherche, filtres, tri, sélection et actions groupées.
 *
 * Le tableau de bord groupe les serveurs par machine, ce qui va très bien à trois serveurs et
 * beaucoup moins à cinquante : il fallait une vue où l'on cherche « atm10 » et où l'on démarre
 * quatre serveurs d'un coup. L'état du filtre vit dans l'URL — une vue se met en favori et se
 * partage.
 */
import { Alert, Button, Group, Select, Stack, Text, Title } from '@mantine/core';
import {
  IconAlertTriangle,
  IconListNumbers,
  IconPlayerPlay,
  IconPlayerStop,
  IconRefresh,
} from '@tabler/icons-react';
import { useState } from 'react';

import type { BulkActionResult } from '@mmo/protocol/client';

import { useGroups } from '../api/groups.js';
import { useBulkAction, useMachines, useMe, useServers } from '../api/queries.js';
import { GroupsModal } from '../components/groups/GroupsPanel.js';
import { ListToolbar } from '../components/ListToolbar.js';
import { ServerCollection } from '../components/ServerCollection.js';
import { useT } from '../i18n/hooks.js';
import { hasRole } from '../lib/format.js';
import type { ListMode } from '../lib/list-view.js';
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
  mode,
  onModeChange,
}: {
  filter: ServerFilter;
  onFilterChange: (next: ServerFilter) => void;
  mode: ListMode;
  onModeChange: (next: ListMode) => void;
}) {
  const { t } = useT();
  const me = useMe();
  const servers = useServers();
  const machines = useMachines();
  const groups = useGroups();
  const bulk = useBulkAction();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [groupsOpen, setGroupsOpen] = useState(false);

  const canOperate = me.data !== undefined && hasRole(me.data.user.role, 'operator');
  const groupName = (id: string | null): string | undefined =>
    id === null ? undefined : groups.data?.groups.find((g) => g.id === id)?.name;
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
        <Title order={1} size="h2">
          {t('web:servers.title')}
        </Title>
        <Group gap="xs">
          {canOperate && (
            <Button
              type="button"
              size="xs"
              variant="light"
              leftSection={<IconListNumbers size={14} />}
              onClick={() => {
                setGroupsOpen(true);
              }}
              data-testid="servers-groups-open"
            >
              {t('web:groups.open')}
            </Button>
          )}
          <Text size="sm" c="dimmed" data-testid="servers-count">
            {filtered
              ? t('web:servers.countFiltered', { shown: shown.length, total: all.length })
              : t('web:servers.count', { count: all.length })}
          </Text>
        </Group>
      </Group>

      <ListToolbar
        search={filter.q}
        onSearch={(q) => {
          set({ q });
        }}
        searchLabel={t('web:servers.search')}
        searchPlaceholder={t('web:servers.searchPlaceholder')}
        searchTestId="servers-search"
        filters={
          <>
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
          </>
        }
        sort={{
          value: filter.sort,
          options: [
            { value: 'name', label: t('web:servers.sort.name') },
            { value: 'state', label: t('web:servers.sort.state') },
            { value: 'started', label: t('web:servers.sort.started') },
            { value: 'ram', label: t('web:servers.sort.ram') },
          ],
          onChange: (v) => {
            if (isServerSort(v)) set({ sort: v });
          },
          testId: 'servers-sort',
        }}
        mode={mode}
        onModeChange={onModeChange}
        modeTestId="servers-view"
        onReset={() => {
          onFilterChange(EMPTY_FILTER);
        }}
        resetDisabled={!filtered && filter.q === '' && filter.sort === 'name'}
        resetTestId="servers-filter-reset"
      />

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

      <ServerCollection
        servers={shown}
        mode={mode}
        emptyLabel={all.length === 0 ? t('web:servers.none') : t('web:servers.noMatch')}
        machineName={machineName}
        groupName={groupName}
        {...(canOperate
          ? {
              selection: {
                selected,
                onToggle: toggle,
                onToggleAll: () => {
                  setSelected(allVisibleSelected ? new Set() : new Set(shown.map((s) => s.id)));
                },
                allSelected: allVisibleSelected,
                someSelected: visibleSelected.length > 0,
              },
            }
          : {})}
      />

      <GroupsModal
        opened={groupsOpen}
        onClose={() => {
          setGroupsOpen(false);
        }}
      />
    </Stack>
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
