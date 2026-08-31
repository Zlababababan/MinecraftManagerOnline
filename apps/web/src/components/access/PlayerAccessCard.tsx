/**
 * Phase 10 — vue d'ensemble d'un serveur : `expose_mode` (tailnet / direct), « adresse à donner aux
 * amis » calculée par le panel (surcharge machine > domaine du panel > adresse détectée par l'agent),
 * copie, alternatives et test de joignabilité (Server List Ping depuis l'hôte du panel).
 */
import {
  Badge,
  Button,
  Card,
  Code,
  CopyButton,
  Group,
  SegmentedControl,
  Stack,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconCopy, IconPlugConnected } from '@tabler/icons-react';

import type { ReachabilityResult, ServerDto } from '@mmo/protocol/client';

import { useServerAddress, useServerReachability } from '../../api/phase10.js';
import { useMe, useUpdateServer } from '../../api/queries.js';
import { useT } from '../../i18n/hooks.js';
import { tDynamic } from '../../i18n/index.js';
import { describeError } from '../../lib/errors.js';
import { hasRole } from '../../lib/format.js';

export function PlayerAccessCard({ server }: { server: ServerDto }) {
  const { t, i18n } = useT();
  const me = useMe();
  const canEdit = me.data !== undefined && hasRole(me.data.user.role, 'operator');
  const address = useServerAddress(server.id);
  const update = useUpdateServer(server.id);
  const test = useServerReachability(server.id);
  const a = address.data?.address;
  const result: ReachabilityResult | undefined = test.data?.result;

  return (
    <Card withBorder radius="md" padding="md" data-testid="player-access">
      <Stack gap="sm">
        <Group gap="xs">
          <IconPlugConnected size={18} />
          <Title order={2} size="h4">
            {t('web:playerAccess.title')}
          </Title>
        </Group>
        <Text size="sm" c="dimmed">
          {t('web:playerAccess.hint')}
        </Text>
        <Group gap="sm" align="center">
          <Text size="sm">{t('web:playerAccess.exposeMode')}</Text>
          <SegmentedControl
            size="xs"
            value={server.exposeMode}
            disabled={!canEdit || update.isPending}
            data={[
              { value: 'tailnet', label: t('web:playerAccess.tailnet') },
              { value: 'direct', label: t('web:playerAccess.direct') },
            ]}
            onChange={(value) => {
              if (value === 'tailnet' || value === 'direct') {
                update.mutate(
                  { exposeMode: value },
                  {
                    onSuccess: () => void address.refetch(),
                    onError: (error) => {
                      notifications.show({ color: 'red', message: describeError(i18n, error) });
                    },
                  },
                );
              }
            }}
            data-testid="expose-mode"
          />
        </Group>
        <Stack gap={4}>
          <Text size="sm">{t('web:playerAccess.address')}</Text>
          {a?.address ? (
            <Group gap="xs" wrap="nowrap">
              <Code
                data-testid="player-address"
                style={{ fontSize: 'var(--mantine-font-size-md)' }}
              >
                {a.address}
              </Code>
              <CopyButton value={a.address}>
                {({ copied, copy }) => (
                  <Tooltip
                    label={copied ? t('web:playerAccess.copied') : t('web:playerAccess.copy')}
                  >
                    <Button
                      type="button"
                      size="compact-xs"
                      variant="light"
                      leftSection={<IconCopy size={14} />}
                      onClick={copy}
                      data-testid="player-address-copy"
                    >
                      {t('web:playerAccess.copy')}
                    </Button>
                  </Tooltip>
                )}
              </CopyButton>
              <Badge size="xs" variant="outline">
                {tDynamic(i18n, `web:playerAccess.source.${a.source}`)}
              </Badge>
            </Group>
          ) : (
            address.data !== undefined && (
              <Text size="sm" className="mmo-warn-text" data-testid="player-address-none">
                {t('web:playerAccess.noAddress')}
              </Text>
            )
          )}
          {a !== undefined && a.alternatives.length > 0 && (
            <Text size="xs" c="dimmed">
              {t('web:playerAccess.alternatives')} : {a.alternatives.join(' · ')}
            </Text>
          )}
        </Stack>
        <Group gap="sm" align="center">
          <Button
            type="button"
            size="xs"
            variant="default"
            disabled={!a?.address || !canEdit}
            loading={test.isPending}
            onClick={() => {
              test.mutate(undefined, {
                onError: (error) => {
                  notifications.show({ color: 'red', message: describeError(i18n, error) });
                },
              });
            }}
            data-testid="player-address-test"
          >
            {test.isPending ? t('web:playerAccess.testing') : t('web:playerAccess.test')}
          </Button>
          {result !== undefined && (
            <Text
              size="sm"
              c={result.ok ? 'teal' : 'red'}
              data-testid="player-address-result"
              data-ok={result.ok}
            >
              {result.ok
                ? t('web:playerAccess.reachable', {
                    version: result.status?.version ?? '?',
                    online: result.status?.online ?? '?',
                    max: result.status?.max ?? '?',
                  })
                : t('web:playerAccess.unreachable', { error: result.error ?? '?' })}
            </Text>
          )}
        </Group>
        <Text size="xs" c="dimmed">
          {t('web:playerAccess.testHint')}
        </Text>
      </Stack>
    </Card>
  );
}
