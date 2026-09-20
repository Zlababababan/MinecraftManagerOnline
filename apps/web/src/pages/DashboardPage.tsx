/** Dashboard : compteurs, machines (statut/heartbeat) + cartes serveurs groupées par machine, événements. */
import { Card, Group, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import { useState } from 'react';
import { RouterButton } from '../components/links.js';
import { useT } from '../i18n/hooks.js';

import type { EventDto } from '@mmo/protocol/client';

import { useConflicts, useEvents, useMachines, useMe, useServers } from '../api/queries.js';
import { ConflictsPanel } from '../components/ConflictsPanel.js';
import { ErrorAlert } from '../components/ErrorAlert.js';
import { EventsList } from '../components/EventsList.js';
import { MachineHeader } from '../components/MachineHeader.js';
import { OnboardingCard } from '../components/OnboardingCard.js';
import { ListToolbar } from '../components/ListToolbar.js';
import { LIST_TOOLBAR_MIN, ServerCollection } from '../components/ServerCollection.js';
import { useNow } from '../lib/hooks.js';
import { hasRole } from '../lib/format.js';
import { useListPrefs, type ListPrefs } from '../lib/list-view.js';
import { EMPTY_FILTER, filterServers, isServerSort } from '../lib/server-filter.js';
import { useRealtimeStore } from '../store/realtime.js';

function Stat({ label, value, testId }: { label: string; value: string | number; testId: string }) {
  return (
    <Card withBorder radius="md" padding="sm">
      <Text size="xs" c="dimmed" tt="uppercase">
        {label}
      </Text>
      <Text fw={700} fz={24} data-testid={testId}>
        {value}
      </Text>
    </Card>
  );
}

/**
 * Le tableau de bord montre les serveurs groupés par machine : les cartes par défaut, et pas de
 * tri propre (l'ordre des machines fait déjà la structure de la page).
 */
const DASHBOARD_LIST: ListPrefs = { mode: 'cards', sort: 'name', desc: false };

export function DashboardPage() {
  const { t } = useT();
  const me = useMe();
  const machines = useMachines();
  const servers = useServers();
  const conflicts = useConflicts();
  const events = useEvents({ limit: 15 });
  const liveEvents = useRealtimeStore((s) => s.recentEvents);
  const [listPrefs, setListPrefs] = useListPrefs('dashboard-servers', DASHBOARD_LIST, isServerSort);
  const [serverQuery, setServerQuery] = useState('');
  const now = useNow(10_000);
  const isAdmin = me.data !== undefined && hasRole(me.data.user.role, 'admin');

  const allServers = servers.data?.servers ?? [];
  const running = allServers.filter((s) => s.runState === 'running').length;
  const merged: EventDto[] = [...liveEvents, ...(events.data?.events ?? [])]
    .filter((e, i, arr) => arr.findIndex((x) => x.id === e.id) === i)
    .sort((a, b) => b.id - a.id)
    .slice(0, 15);
  const nameOf = (e: EventDto): string | undefined =>
    e.serverId !== null
      ? allServers.find((s) => s.id === e.serverId)?.name
      : e.machineId !== null
        ? machines.data?.machines.find((m) => m.id === e.machineId)?.name
        : undefined;

  return (
    <Stack gap="lg" data-testid="dashboard">
      <Group justify="space-between">
        <Title order={1} size="h2">
          {t('web:dashboard.title')}
        </Title>
        {isAdmin && (
          <RouterButton
            to="/machines"
            search={{ add: true }}
            leftSection={<IconPlus size={16} />}
            size="sm"
            data-testid="dashboard-add-machine"
          >
            {t('web:dashboard.addMachine')}
          </RouterButton>
        )}
      </Group>
      <ErrorAlert error={machines.error ?? servers.error} />
      <SimpleGrid cols={{ base: 2, sm: 3 }} spacing="sm">
        <Stat
          label={t('web:dashboard.machines')}
          value={machines.data?.machines.length ?? '…'}
          testId="stat-machines"
        />
        <Stat
          label={t('web:dashboard.servers')}
          value={servers.data === undefined ? '…' : allServers.length}
          testId="stat-servers"
        />
        <Stat
          label={t('web:dashboard.running')}
          value={servers.data === undefined ? '…' : running}
          testId="stat-running"
        />
      </SimpleGrid>
      {conflicts.data !== undefined && <ConflictsPanel conflicts={conflicts.data.conflicts} />}
      <OnboardingCard />
      {allServers.length > LIST_TOOLBAR_MIN && (
        <ListToolbar
          search={serverQuery}
          onSearch={setServerQuery}
          searchLabel={t('web:servers.search')}
          searchPlaceholder={t('web:servers.searchPlaceholder')}
          searchTestId="dashboard-servers-search"
          mode={listPrefs.mode}
          onModeChange={(mode) => {
            setListPrefs({ mode });
          }}
          modeTestId="dashboard-servers-view"
        />
      )}
      {machines.data?.machines.map((machine) => {
        const mine = allServers.filter((s) => s.machineId === machine.id);
        const shown = filterServers(mine, { ...EMPTY_FILTER, q: serverQuery });
        // Une recherche qui ne trouve rien sur une machine efface sa carte : c’est ce qu’on
        // attend d’une recherche. Sans recherche, toutes les machines restent visibles.
        if (serverQuery !== '' && shown.length === 0) return null;
        return (
          <Card
            key={machine.id}
            withBorder
            radius="md"
            padding="md"
            data-testid="machine-group"
            data-machine-id={machine.id}
          >
            <Stack gap="md">
              <MachineHeader machine={machine} now={now} />
              {!machine.connected && machine.status !== 'pending' && mine.length > 0 && (
                <Text size="sm" className="mmo-warn-text">
                  {t('web:dashboard.unreachable')}
                </Text>
              )}
              {mine.length === 0 ? (
                <Text size="sm" c="dimmed">
                  {t('web:dashboard.noServers')} {t('web:dashboard.noServersHint')}
                </Text>
              ) : (
                <ServerCollection
                  servers={shown}
                  mode={listPrefs.mode}
                  emptyLabel={t('web:servers.noMatch')}
                />
              )}
            </Stack>
          </Card>
        );
      })}
      <Card withBorder radius="md" padding="md">
        <Stack gap="sm">
          <Title order={2} size="h4">
            {t('web:dashboard.recentEvents')}
          </Title>
          <EventsList events={merged} resolveName={nameOf} compact />
        </Stack>
      </Card>
    </Stack>
  );
}
