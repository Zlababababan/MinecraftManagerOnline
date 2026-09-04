/**
 * Lot 8 — heures calmes et serveurs en silence, sur la page Compte. Deux réglages personnels qui
 * répondent à la même question : « qu'est-ce qui a le droit de faire sonner mon téléphone ? »
 *
 * Ni l'un ni l'autre ne touche à la cloche du panel : elle garde tout, c'est l'historique. C'est
 * la règle posée en phase 10 quand couper une catégorie la faisait disparaître des deux — et
 * l'écran le dit, plutôt que de laisser la surprise pour plus tard.
 */
import { ActionIcon, Card, Group, Stack, Switch, Table, Text, Title, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconBellOff, IconVolume } from '@tabler/icons-react';
import { useState } from 'react';

import type { QuietHours } from '@mmo/protocol/client';

import { useNotificationPrefs, useSetQuietHours, useSetServerMute } from '../../api/phase10.js';
import { useT } from '../../i18n/hooks.js';
import { describeError } from '../../lib/errors.js';
import { HelpLink } from '../HelpLink.js';

const DEFAULT_QUIET: QuietHours = { from: 22 * 60, to: 7 * 60 };

/** `HH:MM` ↔ minutes depuis minuit : l'input natif `time` parle en `HH:MM`. */
export function toHhMm(minutes: number): string {
  const h = Math.floor(minutes / 60);
  return `${String(h).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

export function fromHhMm(value: string): number | undefined {
  const m = /^(\d{2}):(\d{2})$/.exec(value);
  if (m === null) return undefined;
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  return minutes >= 0 && minutes < 1440 ? minutes : undefined;
}

function MutedServers() {
  const { t } = useT();
  const prefs = useNotificationPrefs();
  const muted = prefs.data?.mutedServers ?? [];
  if (muted.length === 0) return null;
  return (
    <Stack gap={4} data-testid="muted-servers">
      <Text size="sm" fw={600}>
        {t('web:notifications.mutedTitle')}
      </Text>
      <Table>
        <Table.Tbody>
          {muted.map((server) => (
            <Table.Tr key={server.serverId} data-testid={`muted-${server.name}`}>
              <Table.Td>
                <Group gap="xs" wrap="nowrap">
                  <IconBellOff size={16} />
                  <Text size="sm">{server.name}</Text>
                </Group>
              </Table.Td>
              <Table.Td w={48}>
                <UnmuteButton serverId={server.serverId} name={server.name} />
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Stack>
  );
}

function UnmuteButton({ serverId, name }: { serverId: string; name: string }) {
  const { t, i18n } = useT();
  const set = useSetServerMute(serverId);
  const label = t('web:notifications.unmute');
  return (
    <Tooltip label={label}>
      <ActionIcon
        variant="subtle"
        aria-label={`${label} ${name}`}
        loading={set.isPending}
        data-testid={`unmute-${name}`}
        onClick={() => {
          set.mutate(false, {
            onError: (error) => {
              notifications.show({ color: 'red', message: describeError(i18n, error) });
            },
          });
        }}
      >
        <IconVolume size={16} />
      </ActionIcon>
    </Tooltip>
  );
}

export function QuietHoursCard() {
  const { t, i18n } = useT();
  const prefs = useNotificationPrefs();
  const set = useSetQuietHours();
  const quiet = prefs.data?.quietHours ?? null;
  const zone = prefs.data?.timeZone;
  // Une saisie en cours ne doit pas être écrasée par le rafraîchissement de la requête : l'état
  // local ne sert qu'entre deux frappes, l'enregistrement se fait sur `blur`.
  const [draft, setDraft] = useState<QuietHours | null>(null);
  const value = draft ?? quiet;
  const onError = (error: unknown) => {
    notifications.show({ color: 'red', message: describeError(i18n, error) });
  };

  const save = (next: QuietHours | null): void => {
    setDraft(null);
    set.mutate(next, { onError });
  };

  return (
    <Card withBorder radius="md" padding="md" data-testid="quiet-hours">
      <Stack gap="sm">
        <Group gap="xs">
          <Title order={2} size="h4">
            {t('web:notifications.quietTitle')}
          </Title>
          <HelpLink topic="quietHours" />
        </Group>
        <Text size="sm" c="dimmed">
          {t('web:notifications.quietHint')}
        </Text>
        <Switch
          label={t('web:notifications.quietEnable')}
          checked={value !== null}
          disabled={set.isPending}
          data-testid="quiet-enabled"
          onChange={(event) => {
            save(event.currentTarget.checked ? DEFAULT_QUIET : null);
          }}
        />
        {value !== null && (
          <>
            <Group gap="xs" align="flex-end">
              <TimeField
                label={t('web:notifications.quietFrom')}
                value={value.from}
                testId="quiet-from"
                onCommit={(minutes) => {
                  save({ ...value, from: minutes });
                }}
                onDraft={(minutes) => {
                  setDraft({ ...value, from: minutes });
                }}
              />
              <TimeField
                label={t('web:notifications.quietTo')}
                value={value.to}
                testId="quiet-to"
                onCommit={(minutes) => {
                  save({ ...value, to: minutes });
                }}
                onDraft={(minutes) => {
                  setDraft({ ...value, to: minutes });
                }}
              />
            </Group>
            <Text size="xs" c="dimmed" data-testid="quiet-zone">
              {zone === undefined
                ? t('web:notifications.quietZoneUnknown')
                : t('web:notifications.quietZone', { zone })}
            </Text>
          </>
        )}
        <MutedServers />
      </Stack>
    </Card>
  );
}

function TimeField({
  label,
  value,
  testId,
  onCommit,
  onDraft,
}: {
  label: string;
  value: number;
  testId: string;
  onCommit: (minutes: number) => void;
  onDraft: (minutes: number) => void;
}) {
  return (
    <Stack gap={2}>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <input
        type="time"
        value={toHhMm(value)}
        data-testid={testId}
        aria-label={label}
        onChange={(event) => {
          const minutes = fromHhMm(event.currentTarget.value);
          if (minutes !== undefined) onDraft(minutes);
        }}
        onBlur={(event) => {
          const minutes = fromHhMm(event.currentTarget.value);
          if (minutes !== undefined) onCommit(minutes);
        }}
        style={{ padding: '6px 8px', fontSize: 14 }}
      />
    </Stack>
  );
}
