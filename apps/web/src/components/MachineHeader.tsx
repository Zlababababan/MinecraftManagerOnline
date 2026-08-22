/** En-tête machine (dashboard + page machine) : statut, dernier heartbeat, CPU/RAM/disque. */
import { Group, Progress, Stack, Text, Tooltip } from '@mantine/core';
import { RouterAnchor } from './links.js';
import { useT } from '../i18n/hooks.js';

import type { MachineDto } from '@mmo/protocol/client';

import { ago, formatGb, formatMb, formatPct } from '../lib/format.js';
import { MachineStatusBadge } from './badges.js';

function Gauge({ label, value, text }: { label: string; value: number | undefined; text: string }) {
  return (
    <Stack gap={2} style={{ minWidth: 110 }}>
      <Group justify="space-between" gap="xs">
        <Text size="xs" c="dimmed">
          {label}
        </Text>
        <Text size="xs">{text}</Text>
      </Group>
      <Progress
        value={value ?? 0}
        size="xs"
        color={value === undefined ? 'gray' : value > 90 ? 'red' : value > 70 ? 'yellow' : 'teal'}
      />
    </Stack>
  );
}

export function MachineHeader({
  machine,
  now,
  link = true,
}: {
  machine: MachineDto;
  now: number;
  link?: boolean;
}) {
  const { t } = useT();
  const hb = machine.heartbeat;
  const ramPct =
    hb?.ramUsedMb !== undefined && hb.ramTotalMb !== undefined && hb.ramTotalMb > 0
      ? (hb.ramUsedMb / hb.ramTotalMb) * 100
      : undefined;
  const diskPct =
    hb?.diskUsedGb !== undefined && hb.diskTotalGb !== undefined && hb.diskTotalGb > 0
      ? (hb.diskUsedGb / hb.diskTotalGb) * 100
      : undefined;
  const seen = ago(machine.lastSeenAt, now);
  return (
    <Group justify="space-between" align="flex-start" wrap="wrap" gap="md">
      <Stack gap={2} style={{ minWidth: 0 }}>
        <Group gap="xs" wrap="nowrap">
          {link ? (
            <RouterAnchor
              to="/machines/$machineId"
              params={{ machineId: machine.id }}
              fw={700}
              size="lg"
              data-testid="machine-link"
            >
              {machine.name}
            </RouterAnchor>
          ) : (
            <Text fw={700} size="lg">
              {machine.name}
            </Text>
          )}
          <MachineStatusBadge machine={machine} />
        </Group>
        <Text size="xs" c="dimmed">
          {[
            machine.hostname,
            machine.os === null ? undefined : `${machine.os}/${machine.arch ?? '?'}`,
            machine.agentVersion === null ? undefined : `agent ${machine.agentVersion}`,
          ]
            .filter((s) => s !== undefined && s !== '')
            .join(' · ') || t('web:machine.status.pending')}
          {!machine.connected && seen !== undefined && (
            <>
              {' · '}
              {t('web:machine.lastSeen')} {t('web:common.ago', { value: seen })}
            </>
          )}
        </Text>
      </Stack>
      {hb !== undefined && machine.connected && (
        <Group gap="md" wrap="wrap">
          <Tooltip
            label={hb.cpuSource === undefined ? 'CPU' : t(`common:cpuSource.${hb.cpuSource}`)}
            withArrow
          >
            <div>
              <Gauge label={t('web:machine.cpu')} value={hb.cpuPct} text={formatPct(hb.cpuPct)} />
            </div>
          </Tooltip>
          <Gauge
            label={t('web:machine.ram')}
            value={ramPct}
            text={`${formatMb(hb.ramUsedMb)} / ${formatMb(hb.ramTotalMb ?? machine.ramTotalMb)}`}
          />
          <Gauge
            label={t('web:machine.disk')}
            value={diskPct}
            text={`${formatGb(hb.diskUsedGb)} / ${formatGb(hb.diskTotalGb)}`}
          />
        </Group>
      )}
    </Group>
  );
}
