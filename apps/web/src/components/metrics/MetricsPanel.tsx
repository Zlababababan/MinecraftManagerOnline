/**
 * Onglet Métriques d'un serveur (phase 7) : valeurs « maintenant », sélecteur de plage, graphiques
 * CPU / RAM / TPS / joueurs (brut, 1 min ou 1 h selon la plage — la résolution est annoncée),
 * TPS **honnête** (« indisponible » expliqué, spark proposé mais jamais requis), avertissement
 * quand la mesure CPU est par ticks (`cpuSource: 'ticks'`, potentiellement sous-évaluée).
 */
import {
  Alert,
  Anchor,
  Button,
  Card,
  Group,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Text,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle, IconInfoCircle } from '@tabler/icons-react';
import { useState } from 'react';

import type { MachineDto, ServerDto } from '@mmo/protocol/client';
import { compareMcVersions } from '@mmo/shared';

import { useInstallSpark, useSpark } from '../../api/phase8.js';
import {
  METRICS_RANGES,
  useMachineMetrics,
  useMe,
  useServerMetrics,
  type MetricsRange,
} from '../../api/queries.js';
import { useT } from '../../i18n/hooks.js';
import { describeError } from '../../lib/errors.js';
import { formatGb, formatMb, formatPct, hasRole } from '../../lib/format.js';
import { ErrorAlert } from '../ErrorAlert.js';
import { TimeSeriesChart } from './TimeSeriesChart.js';

const SPARK_URL = 'https://spark.lucko.me/download';

/** `12%`, `0.5%` : une décimale seulement quand l'échelle est fine. */
function pct(v: number): string {
  return `${Number.isInteger(v) ? String(v) : v.toFixed(1)}%`;
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Stack gap={0}>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text size="lg" fw={600}>
        {value}
      </Text>
      {hint !== undefined && (
        <Text size="xs" c="dimmed">
          {hint}
        </Text>
      )}
    </Stack>
  );
}

function RangeControl({
  value,
  onChange,
}: {
  value: MetricsRange;
  onChange: (r: MetricsRange) => void;
}) {
  const { t } = useT();
  return (
    <SegmentedControl
      size="xs"
      value={value}
      onChange={(v) => {
        onChange(v as MetricsRange);
      }}
      data={METRICS_RANGES.map((r) => ({ value: r, label: t(`web:metrics.ranges.${r}`) }))}
      data-testid="metrics-range"
    />
  );
}

export function CpuSourceWarning({ source }: { source: string | null | undefined }) {
  const { t } = useT();
  if (source !== 'ticks') return null;
  return (
    <Alert
      color="yellow"
      icon={<IconAlertTriangle size={16} />}
      title={t('web:metrics.cpuTicks.title')}
      data-testid="cpu-ticks-warning"
    >
      {t('web:metrics.cpuTicks.body')}
    </Alert>
  );
}

/** Raison honnête de l'absence de TPS selon le loader / la version. */
export function tpsUnavailableReason(
  server: Pick<ServerDto, 'loader' | 'mcVersion' | 'runState'>,
): 'notRunning' | 'vanillaOld' | 'fabricNoSpark' | 'forgeNoAnswer' | 'proxy' | 'unknown' {
  if (server.runState !== 'running') return 'notRunning';
  const tickQuery =
    server.mcVersion !== null && (compareMcVersions(server.mcVersion, '1.20.3') ?? -1) >= 0;
  switch (server.loader) {
    case 'vanilla':
      return tickQuery ? 'unknown' : 'vanillaOld';
    case 'fabric':
      return tickQuery ? 'unknown' : 'fabricNoSpark';
    case 'forge':
    case 'neoforge':
      return 'forgeNoAnswer';
    // Un proxy n'a pas de ticks : le TPS n'existe pas, ce n'est pas une panne.
    case 'velocity':
      return 'proxy';
    case 'unknown':
      return 'unknown';
  }
}

/** « Installer spark en un clic » (dette phase 7, via `fs.fetch`) — jamais requis. */
function SparkInstall({ server }: { server: ServerDto }) {
  const { t, i18n } = useT();
  const me = useMe();
  const spark = useSpark(server.id, server.reachable);
  const install = useInstallSpark(server.id);
  const canAct =
    me.data !== undefined && hasRole(me.data.user.role, 'operator') && server.reachable;
  if (!spark.data?.supported) return null;
  if (spark.data.installed) {
    return (
      <Text size="sm" mt="xs" data-testid="spark-installed">
        {t('web:metrics.sparkInstalled', { file: spark.data.file ?? 'spark' })}
      </Text>
    );
  }
  if (!canAct) return null;
  return (
    <Group mt="xs" gap="xs">
      <Button
        type="button"
        size="xs"
        variant="light"
        loading={install.isPending}
        data-testid="spark-install"
        onClick={() => {
          install.mutate(undefined, {
            onSuccess: () => {
              notifications.show({ message: t('web:metrics.sparkInstallStarted') });
            },
            onError: (error) => {
              notifications.show({ color: 'red', message: describeError(i18n, error) });
            },
          });
        }}
      >
        {t('web:metrics.sparkInstall')}
      </Button>
      <Text size="xs" c="dimmed">
        {t('web:metrics.sparkInstallHint')}
      </Text>
    </Group>
  );
}

export function ServerMetricsPanel({ server }: { server: ServerDto }) {
  const { t } = useT();
  const [range, setRange] = useState<MetricsRange>('1h');
  const q = useServerMetrics(server.id, range);
  const data = q.data;
  const points = data?.points ?? [];
  const timestamps = points.map((p) => p.ts);
  const aggregated = data !== undefined && data.resolution !== 'raw';
  const latest = data?.latest ?? null;
  const tpsSource = data?.tpsSource ?? null;
  const tpsAvailable = latest !== null && latest.tps !== null;
  const reason = tpsUnavailableReason(server);
  const now = Date.now();
  const from = data?.from ?? now - 3_600_000;
  const to = data?.to ?? now;

  return (
    <Stack gap="md" data-testid="metrics-panel">
      {q.error !== null && <ErrorAlert error={q.error} />}
      <CpuSourceWarning source={data?.cpuSource} />
      <Card withBorder padding="md">
        <Group justify="space-between" align="flex-start" wrap="wrap">
          <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="lg">
            <Stat
              label={t('web:metrics.cpu')}
              value={
                latest?.cpu === null || latest?.cpu === undefined ? '—' : formatPct(latest.cpu)
              }
              hint={t('web:metrics.cpuCoreHint')}
            />
            <Stat
              label={t('web:metrics.ram')}
              value={latest?.ram === null || latest?.ram === undefined ? '—' : formatMb(latest.ram)}
              hint={`${t('web:metrics.ramMax')} ${formatMb(server.maxRamMb)}`}
            />
            <Stat
              label={t('web:metrics.tps')}
              value={tpsAvailable && latest.tps !== null ? latest.tps.toFixed(1) : '—'}
              hint={
                tpsAvailable
                  ? `${latest.mspt === null || latest.mspt === undefined ? '' : `${latest.mspt.toFixed(1)} ms · `}${t(`web:metrics.tpsSource.${tpsSource ?? 'unknown'}`)}`
                  : t('web:metrics.tpsUnavailable')
              }
            />
            <Stat
              label={t('web:metrics.players')}
              value={
                latest?.players === null || latest?.players === undefined
                  ? '—'
                  : String(latest.players)
              }
            />
          </SimpleGrid>
          <RangeControl value={range} onChange={setRange} />
        </Group>
        {data !== undefined && (
          <Text size="xs" c="dimmed" mt="xs" data-testid="metrics-resolution">
            {t(`web:metrics.resolution.${data.resolution}`)}
          </Text>
        )}
      </Card>

      {!tpsAvailable && server.runState === 'running' && (
        <Alert
          color="gray"
          icon={<IconInfoCircle size={16} />}
          title={t('web:metrics.tpsUnavailable')}
          data-testid="tps-unavailable"
        >
          {t(`web:metrics.tpsReason.${reason}`)}
          {reason === 'fabricNoSpark' && (
            <>
              {' '}
              <Anchor href={SPARK_URL} target="_blank" rel="noreferrer">
                {t('web:metrics.sparkLink')}
              </Anchor>
              {' — '}
              {t('web:metrics.sparkNeverRequired')}
            </>
          )}
          {(reason === 'fabricNoSpark' || reason === 'forgeNoAnswer') && (
            <SparkInstall server={server} />
          )}
        </Alert>
      )}

      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
        <Card withBorder padding="sm">
          <Text size="sm" fw={600} mb={4}>
            {t('web:metrics.charts.cpu')}
          </Text>
          <TimeSeriesChart
            timestamps={timestamps}
            from={from}
            to={to}
            format={pct}
            series={[
              {
                key: 'cpu',
                label: aggregated ? t('web:metrics.avg') : t('web:metrics.cpu'),
                color: 'var(--mantine-color-teal-5)',
                values: points.map((p) => p.cpu),
                ...(aggregated ? { band: points.map((p) => p.cpuMax ?? null) } : {}),
              },
            ]}
            testId="chart-cpu"
          />
        </Card>
        <Card withBorder padding="sm">
          <Text size="sm" fw={600} mb={4}>
            {t('web:metrics.charts.ram')}
          </Text>
          <TimeSeriesChart
            timestamps={timestamps}
            from={from}
            to={to}
            format={(v) => formatMb(Math.round(v))}
            reference={{ value: server.maxRamMb, label: t('web:metrics.ramMax') }}
            series={[
              {
                key: 'ram',
                label: t('web:metrics.ram'),
                color: 'var(--mantine-color-violet-5)',
                values: points.map((p) => p.ram),
                ...(aggregated ? { band: points.map((p) => p.ramMax ?? null) } : {}),
              },
            ]}
            testId="chart-ram"
          />
        </Card>
        <Card withBorder padding="sm">
          <Text size="sm" fw={600} mb={4}>
            {t('web:metrics.charts.tps')}
          </Text>
          <TimeSeriesChart
            timestamps={timestamps}
            from={from}
            to={to}
            yMax={20}
            format={(v) => v.toFixed(0)}
            empty={t('web:metrics.tpsUnavailable')}
            series={[
              {
                key: 'tps',
                label: t('web:metrics.tps'),
                color: 'var(--mantine-color-orange-5)',
                values: points.map((p) => p.tps),
                ...(aggregated ? { band: points.map((p) => p.tpsMin ?? null) } : {}),
              },
            ]}
            testId="chart-tps"
          />
        </Card>
        <Card withBorder padding="sm">
          <Text size="sm" fw={600} mb={4}>
            {t('web:metrics.charts.players')}
          </Text>
          <TimeSeriesChart
            timestamps={timestamps}
            from={from}
            to={to}
            format={(v) => String(Math.round(v))}
            integer
            series={[
              {
                key: 'players',
                label: t('web:metrics.players'),
                color: 'var(--mantine-color-blue-5)',
                values: points.map((p) => p.players),
              },
            ]}
            testId="chart-players"
          />
        </Card>
      </SimpleGrid>
    </Stack>
  );
}

export function MachineMetricsPanel({ machine }: { machine: MachineDto }) {
  const { t } = useT();
  const [range, setRange] = useState<MetricsRange>('1h');
  const q = useMachineMetrics(machine.id, range);
  const data = q.data;
  const points = data?.points ?? [];
  const timestamps = points.map((p) => p.ts);
  const aggregated = data !== undefined && data.resolution !== 'raw';
  const latest = data?.latest ?? null;
  const now = Date.now();
  const from = data?.from ?? now - 3_600_000;
  const to = data?.to ?? now;
  const ramTotal = machine.heartbeat?.ramTotalMb ?? machine.ramTotalMb ?? undefined;

  return (
    <Stack gap="md" data-testid="machine-metrics-panel">
      {q.error !== null && <ErrorAlert error={q.error} />}
      <CpuSourceWarning source={data?.cpuSource ?? machine.heartbeat?.cpuSource} />
      <Group justify="space-between" wrap="wrap">
        <SimpleGrid cols={3} spacing="lg">
          <Stat
            label={t('web:machine.cpu')}
            value={latest?.cpu === null || latest?.cpu === undefined ? '—' : formatPct(latest.cpu)}
          />
          <Stat
            label={t('web:machine.ram')}
            value={latest?.ram === null || latest?.ram === undefined ? '—' : formatMb(latest.ram)}
            {...(ramTotal === undefined ? {} : { hint: `/ ${formatMb(ramTotal)}` })}
          />
          <Stat
            label={t('web:machine.disk')}
            value={
              latest?.diskUsedGb === null || latest?.diskUsedGb === undefined
                ? '—'
                : `${formatGb(latest.diskUsedGb)} / ${formatGb(latest.diskTotalGb)}`
            }
          />
        </SimpleGrid>
        <RangeControl value={range} onChange={setRange} />
      </Group>
      {data !== undefined && (
        <Text size="xs" c="dimmed" data-testid="metrics-resolution">
          {t(`web:metrics.resolution.${data.resolution}`)}
        </Text>
      )}
      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
        <Card withBorder padding="sm">
          <Text size="sm" fw={600} mb={4}>
            {t('web:metrics.charts.machineCpu')}
          </Text>
          <TimeSeriesChart
            timestamps={timestamps}
            from={from}
            to={to}
            yMax={100}
            format={pct}
            series={[
              {
                key: 'cpu',
                label: t('web:machine.cpu'),
                color: 'var(--mantine-color-teal-5)',
                values: points.map((p) => p.cpu),
                ...(aggregated ? { band: points.map((p) => p.cpuMax ?? null) } : {}),
              },
            ]}
            testId="chart-machine-cpu"
          />
        </Card>
        <Card withBorder padding="sm">
          <Text size="sm" fw={600} mb={4}>
            {t('web:metrics.charts.machineRam')}
          </Text>
          <TimeSeriesChart
            timestamps={timestamps}
            from={from}
            to={to}
            {...(ramTotal === undefined ? {} : { yMax: ramTotal })}
            format={(v) => formatMb(Math.round(v))}
            series={[
              {
                key: 'ram',
                label: t('web:machine.ram'),
                color: 'var(--mantine-color-violet-5)',
                values: points.map((p) => p.ram),
                ...(aggregated ? { band: points.map((p) => p.ramMax ?? null) } : {}),
              },
            ]}
            testId="chart-machine-ram"
          />
        </Card>
      </SimpleGrid>
    </Stack>
  );
}
