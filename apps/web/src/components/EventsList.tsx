/** Liste d'événements (dashboard, page serveur) — libellés traduits par type, charge utile en détail. */
import { Group, Stack, Text } from '@mantine/core';
import { DataTable } from 'mantine-datatable';
import { useT } from '../i18n/hooks.js';

import type { EventDto } from '@mmo/protocol/client';

import { tDynamic } from '../i18n/index.js';
import { formatDateTime } from '../lib/format.js';
import { SeverityBadge } from './badges.js';

export function eventLabel(
  t: (key: string, options: Record<string, unknown>) => string,
  event: EventDto,
  exists: (key: string) => boolean,
): string {
  const payload =
    typeof event.payload === 'object' && event.payload !== null
      ? (event.payload as Record<string, unknown>)
      : {};
  const key = `web:events.types.${event.type}`;
  if (exists(key)) {
    const state = typeof payload.state === 'string' ? payload.state : undefined;
    const kind = typeof payload.kind === 'string' ? payload.kind : undefined;
    const action = typeof payload.action === 'string' ? payload.action : undefined;
    return t(key, {
      ...payload,
      state: state === undefined ? '' : t(`common:runState.${state}`, { defaultValue: state }),
      kindLabel: kind === undefined ? '' : t(`web:watchdog.kind.${kind}`, { defaultValue: kind }),
      actionLabel:
        action === undefined
          ? ''
          : t(`web:watchdog.action.${action}`, { defaultValue: action, ...payload }),
    });
  }
  return event.type;
}

export function EventsList({
  events,
  resolveName,
  compact = false,
}: {
  events: EventDto[];
  /** Nom lisible d'une machine / d'un serveur à partir de son ID. */
  resolveName?: (event: EventDto) => string | undefined;
  compact?: boolean;
}) {
  const { t, i18n } = useT();
  const exists = (key: string): boolean => i18n.exists(key);
  const label = (e: EventDto): string => eventLabel((k, o) => tDynamic(i18n, k, o), e, exists);

  if (compact) {
    return (
      <Stack gap={6} data-testid="events-compact">
        {events.length === 0 && (
          <Text size="sm" c="dimmed">
            {t('web:dashboard.noEvents')}
          </Text>
        )}
        {events.map((e) => (
          <Group key={e.id} gap="xs" wrap="nowrap" align="flex-start">
            <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
              {formatDateTime(e.ts, i18n.language)}
            </Text>
            <SeverityBadge severity={e.severity} />
            <Text size="sm" truncate="end">
              {resolveName?.(e) !== undefined && (
                <Text span fw={600}>
                  {resolveName(e)} ·{' '}
                </Text>
              )}
              {label(e)}
            </Text>
          </Group>
        ))}
      </Stack>
    );
  }

  return (
    <DataTable
      records={events}
      idAccessor="id"
      withTableBorder
      borderRadius="sm"
      striped
      highlightOnHover
      {...(events.length === 0 ? { minHeight: 120 } : {})}
      noRecordsText={t('web:dashboard.noEvents')}
      columns={[
        {
          accessor: 'ts',
          title: t('web:events.time'),
          width: 170,
          render: (e) => formatDateTime(e.ts, i18n.language),
        },
        {
          accessor: 'severity',
          title: t('web:events.severity'),
          width: 110,
          render: (e) => <SeverityBadge severity={e.severity} />,
        },
        {
          accessor: 'type',
          title: t('web:events.type'),
          render: (e) => (
            <Stack gap={0}>
              <Text size="sm">
                {resolveName?.(e) !== undefined && (
                  <Text span fw={600}>
                    {resolveName(e)} ·{' '}
                  </Text>
                )}
                {label(e)}
              </Text>
              <Text size="xs" c="dimmed" ff="monospace">
                {e.type}
              </Text>
            </Stack>
          ),
        },
      ]}
    />
  );
}
