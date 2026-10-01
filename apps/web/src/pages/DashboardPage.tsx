/**
 * Tableau de bord : « qu'est-ce qui se passe maintenant, et que puis-je faire tout de suite ? ».
 *
 * Il ne liste plus tous les serveurs (retour de Yassin, 01/10 : c'était une copie de la page
 * machine, les actions en moins). Il montre ce qui tourne, ce qui demande un geste et les derniers
 * serveurs utilisés ; la liste complète est à un clic (« Tous les serveurs »), et **créer un
 * serveur se fait d'ici**, sans passer par la page de la machine.
 */
import { Card, Group, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { IconList, IconPlus } from '@tabler/icons-react';

import type { EventDto } from '@mmo/protocol/client';

import { useConflicts, useEvents, useMachines, useMe, useServers } from '../api/queries.js';
import { ConflictsPanel } from '../components/ConflictsPanel.js';
import { ErrorAlert } from '../components/ErrorAlert.js';
import { EventsList } from '../components/EventsList.js';
import { RouterAnchor, RouterButton } from '../components/links.js';
import { CreateServerButton } from '../components/machine/CreateServerButton.js';
import { MachineHeader } from '../components/MachineHeader.js';
import { OnboardingCard } from '../components/OnboardingCard.js';
import { ServerCollection } from '../components/ServerCollection.js';
import { useT } from '../i18n/hooks.js';
import { dashboardSections } from '../lib/dashboard.js';
import { hasRole } from '../lib/format.js';
import { useNow } from '../lib/hooks.js';
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

export function DashboardPage() {
  const { t } = useT();
  const me = useMe();
  const machines = useMachines();
  const servers = useServers();
  const conflicts = useConflicts();
  const events = useEvents({ limit: 15 });
  const liveEvents = useRealtimeStore((s) => s.recentEvents);
  const now = useNow(10_000);
  const isAdmin = me.data !== undefined && hasRole(me.data.user.role, 'admin');

  const allMachines = machines.data?.machines ?? [];
  const allServers = servers.data?.servers ?? [];
  const sections = dashboardSections(allServers);
  // Avec plusieurs machines, chaque carte dit où vit le serveur.
  const machineName =
    allMachines.length > 1
      ? (id: string) => allMachines.find((m) => m.id === id)?.name ?? id
      : undefined;
  const merged: EventDto[] = [...liveEvents, ...(events.data?.events ?? [])]
    .filter((e, i, arr) => arr.findIndex((x) => x.id === e.id) === i)
    .sort((a, b) => b.id - a.id)
    .slice(0, 15);
  const nameOf = (e: EventDto): string | undefined =>
    e.serverId !== null
      ? allServers.find((s) => s.id === e.serverId)?.name
      : e.machineId !== null
        ? allMachines.find((m) => m.id === e.machineId)?.name
        : undefined;

  return (
    <Stack gap="lg" data-testid="dashboard">
      <Group justify="space-between">
        <Title order={1} size="h2">
          {t('web:dashboard.title')}
        </Title>
        <Group gap="xs">
          <CreateServerButton testId="dashboard-create-server" />
          <RouterButton
            to="/servers"
            variant="default"
            size="sm"
            leftSection={<IconList size={16} />}
            data-testid="dashboard-all-servers"
          >
            {t('web:dashboard.allServers', { count: allServers.length })}
          </RouterButton>
          {isAdmin && (
            <RouterButton
              to="/machines"
              search={{ add: true }}
              variant="subtle"
              leftSection={<IconPlus size={16} />}
              size="sm"
              data-testid="dashboard-add-machine"
            >
              {t('web:dashboard.addMachine')}
            </RouterButton>
          )}
        </Group>
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
          value={servers.data === undefined ? '…' : sections.runningCount}
          testId="stat-running"
        />
      </SimpleGrid>
      {conflicts.data !== undefined && <ConflictsPanel conflicts={conflicts.data.conflicts} />}
      <OnboardingCard />

      {sections.favorites.length > 0 && (
        <Card withBorder radius="md" padding="md" data-testid="dashboard-favorites">
          <Stack gap="sm">
            <Title order={2} size="h4">
              {t('web:dashboard.favorites')}
            </Title>
            <ServerCollection
              servers={sections.favorites}
              mode="cards"
              emptyLabel=""
              {...(machineName === undefined ? {} : { machineName })}
            />
          </Stack>
        </Card>
      )}

      {sections.attention.length > 0 && (
        <Card withBorder radius="md" padding="md" data-testid="dashboard-attention">
          <Stack gap="sm">
            <Title order={2} size="h4">
              {t('web:dashboard.attention')}
            </Title>
            <ServerCollection
              servers={sections.attention}
              mode="cards"
              emptyLabel=""
              {...(machineName === undefined ? {} : { machineName })}
            />
          </Stack>
        </Card>
      )}

      <Card withBorder radius="md" padding="md" data-testid="dashboard-active">
        <Stack gap="sm">
          <Title order={2} size="h4">
            {t('web:dashboard.running')}
          </Title>
          <ServerCollection
            servers={sections.active}
            mode="cards"
            emptyLabel={t('web:dashboard.noneRunning')}
            {...(machineName === undefined ? {} : { machineName })}
          />
        </Stack>
      </Card>

      {sections.recent.length > 0 && (
        <Card withBorder radius="md" padding="md" data-testid="dashboard-recent">
          <Stack gap="sm">
            <Group justify="space-between">
              <Title order={2} size="h4">
                {t('web:dashboard.recent')}
              </Title>
              <RouterAnchor to="/servers" size="sm" data-testid="dashboard-recent-all">
                {t('web:dashboard.allServers', { count: allServers.length })}
              </RouterAnchor>
            </Group>
            <ServerCollection
              servers={sections.recent}
              mode="cards"
              emptyLabel=""
              {...(machineName === undefined ? {} : { machineName })}
            />
          </Stack>
        </Card>
      )}

      <Card withBorder radius="md" padding="md">
        <Stack gap="sm">
          <Title order={2} size="h4">
            {t('web:dashboard.recentEvents')}
          </Title>
          <EventsList events={merged} resolveName={nameOf} compact />
        </Stack>
      </Card>

      {allMachines.map((machine) => {
        const count = allServers.filter((s) => s.machineId === machine.id).length;
        return (
          <Card
            key={machine.id}
            withBorder
            radius="md"
            padding="md"
            data-testid="machine-group"
            data-machine-id={machine.id}
          >
            <Stack gap="sm">
              <MachineHeader machine={machine} now={now} />
              {!machine.connected && machine.status !== 'pending' && count > 0 && (
                <Text size="sm" className="mmo-warn-text">
                  {t('web:dashboard.unreachable')}
                </Text>
              )}
              <Text size="sm" c="dimmed">
                {count === 0
                  ? `${t('web:dashboard.noServers')} ${t('web:dashboard.noServersHint')}`
                  : t('web:servers.count', { count })}
              </Text>
            </Stack>
          </Card>
        );
      })}
    </Stack>
  );
}
