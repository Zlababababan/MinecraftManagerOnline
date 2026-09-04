/**
 * Lot 8 — « Statistiques » de l'onglet Joueurs : ce que `player_sessions` sait dire d'un serveur.
 * Quatre chiffres, la fréquentation jour par jour, les heures où l'on joue, et le classement des
 * temps de jeu. Aucune dépendance graphique : le graphique de séries temporelles existe déjà, et
 * l'histogramme des heures tient en une poignée de rectangles SVG.
 *
 * Les journées et les heures sont celles du PANEL (son fuseau, affiché sous les graphiques) :
 * lues dans un autre, elles ne voudraient rien dire — c'est la leçon des planifications.
 */
import {
  Badge,
  Card,
  Group,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Table,
  Text,
} from '@mantine/core';
import { useState } from 'react';

import { PLAYER_STATS_RANGES, type PlayerStatsDto, type ServerDto } from '@mmo/protocol/client';

import { usePlayerStats } from '../../api/queries.js';
import { useT } from '../../i18n/hooks.js';
import { formatDateTime, formatPlaytime } from '../../lib/format.js';
import { ErrorAlert } from '../ErrorAlert.js';
import { HelpLink } from '../HelpLink.js';
import { TimeSeriesChart } from '../metrics/TimeSeriesChart.js';
import { PlayerAvatar } from './PlayerAvatar.js';

// `hint?: string | undefined` et non `hint?: string` : sous `exactOptionalPropertyTypes`, passer
// explicitement `undefined` est refusé (piège connu).
function Tile({
  label,
  value,
  hint,
  testId,
}: {
  label: string;
  value: string;
  hint?: string | undefined;
  testId: string;
}) {
  return (
    <Card withBorder padding="sm" radius="md">
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text size="xl" fw={600} data-testid={testId}>
        {value}
      </Text>
      {hint !== undefined && (
        <Text size="xs" c="dimmed">
          {hint}
        </Text>
      )}
    </Card>
  );
}

/** Temps de jeu par heure murale : 24 barres, la plus haute donnant l'échelle. */
function HoursChart({ hours }: { hours: number[] }) {
  const { t } = useT();
  const max = Math.max(...hours, 1);
  return (
    <svg
      viewBox="0 0 240 60"
      preserveAspectRatio="none"
      style={{ width: '100%', height: 96 }}
      role="img"
      aria-label={t('web:server.players.stats.hours')}
      data-testid="stats-hours"
    >
      {hours.map((value, hour) => {
        const height = value === 0 ? 0 : Math.max(1, (value / max) * 46);
        return (
          <rect
            key={hour}
            x={hour * 10 + 1}
            y={50 - height}
            width={8}
            height={height}
            rx={1}
            fill="var(--mantine-color-teal-5)"
            data-testid={`stats-hour-${String(hour)}`}
            data-value={value}
          />
        );
      })}
      {[0, 6, 12, 18].map((hour) => (
        <text
          key={hour}
          x={hour * 10 + 5}
          y={59}
          textAnchor="middle"
          fontSize={6}
          fill="var(--mantine-color-dimmed)"
        >
          {String(hour)}h
        </text>
      ))}
    </svg>
  );
}

function Charts({ stats }: { stats: PlayerStatsDto }) {
  const { t, i18n } = useT();
  const timestamps = stats.days.map((d) => d.start);
  return (
    <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
      <Card withBorder padding="sm">
        <Text size="sm" fw={600} mb={4}>
          {t('web:server.players.stats.daily')}
        </Text>
        <TimeSeriesChart
          timestamps={timestamps}
          from={stats.from}
          to={stats.to}
          integer
          format={(v) => String(Math.round(v))}
          testId="stats-daily"
          series={[
            {
              key: 'players',
              label: t('web:server.players.stats.players'),
              color: 'var(--mantine-color-teal-5)',
              values: stats.days.map((d) => d.players),
            },
            {
              key: 'sessions',
              label: t('web:server.players.stats.sessions'),
              color: 'var(--mantine-color-blue-5)',
              values: stats.days.map((d) => d.sessions),
              dashed: true,
            },
          ]}
        />
      </Card>
      <Card withBorder padding="sm">
        <Text size="sm" fw={600} mb={4}>
          {t('web:server.players.stats.hours')}
        </Text>
        <HoursChart hours={stats.hours} />
        <Text size="xs" c="dimmed" mt={4}>
          {t('web:server.players.stats.timeZone', { zone: stats.timeZone })}
        </Text>
      </Card>
      <Card withBorder padding="sm" style={{ gridColumn: '1 / -1' }}>
        <Text size="sm" fw={600} mb={4}>
          {t('web:server.players.stats.playtimePerDay')}
        </Text>
        <TimeSeriesChart
          timestamps={timestamps}
          from={stats.from}
          to={stats.to}
          format={(v) => formatPlaytime(v)}
          testId="stats-playtime"
          series={[
            {
              key: 'playtime',
              label: t('web:server.players.stats.playtime'),
              color: 'var(--mantine-color-violet-5)',
              values: stats.days.map((d) => d.playtimeMs),
            },
          ]}
        />
        <Text size="xs" c="dimmed" mt={4}>
          {formatDateTime(stats.from, i18n.language)} → {formatDateTime(stats.to, i18n.language)}
        </Text>
      </Card>
    </SimpleGrid>
  );
}

export function PlayerStatsView({ server }: { server: ServerDto }) {
  const { t, i18n } = useT();
  const [days, setDays] = useState<number>(30);
  const query = usePlayerStats(server.id, days);
  const stats = query.data?.stats;

  return (
    <Stack gap="md" data-testid="player-stats">
      <Group justify="space-between">
        <HelpLink topic="playerStats" />
        <SegmentedControl
          size="xs"
          value={String(days)}
          onChange={(v) => {
            setDays(Number(v));
          }}
          data={PLAYER_STATS_RANGES.map((r) => ({
            value: String(r),
            label: t('web:server.players.stats.range', { days: r }),
          }))}
          data-testid="stats-range"
        />
      </Group>
      {query.error && <ErrorAlert error={query.error} />}
      {stats !== undefined && (
        <>
          <SimpleGrid cols={{ base: 2, md: 4 }} spacing="sm">
            <Tile
              testId="stat-players"
              label={t('web:server.players.stats.totalPlayers')}
              value={String(stats.totals.players)}
              hint={
                stats.totals.newPlayers > 0
                  ? t('web:server.players.stats.newPlayers', { count: stats.totals.newPlayers })
                  : undefined
              }
            />
            <Tile
              testId="stat-sessions"
              label={t('web:server.players.stats.totalSessions')}
              value={String(stats.totals.sessions)}
            />
            <Tile
              testId="stat-playtime"
              label={t('web:server.players.stats.totalPlaytime')}
              value={formatPlaytime(stats.totals.playtimeMs)}
            />
            <Tile
              testId="stat-peak"
              label={t('web:server.players.stats.peak')}
              value={String(stats.totals.peakPlayers)}
              hint={
                stats.totals.peakAt === null
                  ? undefined
                  : formatDateTime(stats.totals.peakAt, i18n.language)
              }
            />
          </SimpleGrid>
          <Charts stats={stats} />
          {stats.top.length === 0 ? (
            <Text size="sm" c="dimmed" data-testid="stats-empty">
              {t('web:server.players.stats.empty')}
            </Text>
          ) : (
            <Table striped withTableBorder data-testid="stats-top">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('web:server.players.name')}</Table.Th>
                  <Table.Th>{t('web:server.players.stats.playtime')}</Table.Th>
                  <Table.Th visibleFrom="sm">
                    {t('web:server.players.stats.sessionsShort')}
                  </Table.Th>
                  <Table.Th visibleFrom="sm">{t('web:server.players.stats.lastSeen')}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {stats.top.map((p) => (
                  <Table.Tr key={p.name} data-testid={`stats-player-${p.name}`}>
                    <Table.Td>
                      <Group gap="xs" wrap="nowrap">
                        <PlayerAvatar name={p.name} uuid={p.uuid} size={28} />
                        <Text size="sm" fw={500}>
                          {p.name}
                        </Text>
                        {p.isNew && (
                          <Badge size="xs" variant="light" color="teal">
                            {t('web:server.players.stats.new')}
                          </Badge>
                        )}
                      </Group>
                    </Table.Td>
                    <Table.Td data-testid={`stats-playtime-${p.name}`}>
                      {formatPlaytime(p.playtimeMs)}
                    </Table.Td>
                    <Table.Td visibleFrom="sm">{p.sessions}</Table.Td>
                    <Table.Td visibleFrom="sm">
                      {formatDateTime(p.lastSeenAt, i18n.language)}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          )}
        </>
      )}
    </Stack>
  );
}
