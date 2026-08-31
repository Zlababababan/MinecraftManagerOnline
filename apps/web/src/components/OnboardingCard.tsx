/**
 * Premiers pas guidés (lot 7) : remplace l'alerte « aucune machine » du dashboard par quatre
 * étapes cochées automatiquement depuis l'état déjà chargé (machines, serveurs), plus une ligne
 * « accès à distance » alimentée par le hook d'accès. La carte disparaît quand tout est vert.
 */
import { Badge, Card, Group, Stack, Text, ThemeIcon, Title } from '@mantine/core';
import { IconCheck, IconWorld } from '@tabler/icons-react';

import { useAccessStatus } from '../api/phase10.js';
import { useMachines, useMe, useServers } from '../api/queries.js';
import { useT } from '../i18n/hooks.js';
import { tDynamic } from '../i18n/index.js';
import { hasRole } from '../lib/format.js';
import { RouterButton } from './links.js';

export function OnboardingCard() {
  const { t, i18n } = useT();
  const me = useMe();
  const machines = useMachines();
  const servers = useServers();
  const access = useAccessStatus();
  const all = machines.data?.machines;
  if (all === undefined || servers.data === undefined) return null;
  const isAdmin = me.data !== undefined && hasRole(me.data.user.role, 'admin');
  const connected = all.filter((m) => m.connected);
  const watched = all.find((m) => m.watchedDirectories.some((d) => d.enabled));
  const steps = [
    { key: 'machine', done: all.length > 0 },
    { key: 'connected', done: connected.length > 0 },
    { key: 'directory', done: watched !== undefined },
    { key: 'server', done: servers.data.servers.length > 0 },
  ] as const;
  if (steps.every((s) => s.done)) return null;
  // Machine à ouvrir pour finir chaque étape (l'appairage se fait sur la machine non connectée,
  // le répertoire et le scan sur une machine joignable).
  const openTargets: Record<'connected' | 'directory' | 'server', string | undefined> = {
    connected: all.find((m) => !m.connected)?.id,
    directory: (connected[0] ?? all[0])?.id,
    server: (watched ?? connected[0] ?? all[0])?.id,
  };
  const a = access.data?.access;
  return (
    <Card withBorder radius="md" padding="md" data-testid="onboarding">
      <Stack gap="sm">
        <Title order={2} size="h4">
          {t('web:dashboard.onboarding.title')}
        </Title>
        <Text size="sm" c="dimmed">
          {t('web:dashboard.onboarding.intro')}
        </Text>
        {steps.map((step, i) => {
          const machineId = step.key === 'machine' ? undefined : openTargets[step.key];
          return (
            <Group
              key={step.key}
              gap="sm"
              data-testid={`onboarding-step-${step.key}`}
              data-done={step.done}
            >
              <ThemeIcon
                size="sm"
                radius="xl"
                color={step.done ? 'teal' : 'gray'}
                variant={step.done ? 'filled' : 'light'}
              >
                {step.done ? (
                  <IconCheck size={12} />
                ) : (
                  <Text size="xs" fw={600} component="span">
                    {i + 1}
                  </Text>
                )}
              </ThemeIcon>
              <Text size="sm" c={step.done ? 'dimmed' : undefined}>
                {tDynamic(i18n, `web:dashboard.onboarding.${step.key}`)}
              </Text>
              {!step.done &&
                isAdmin &&
                (step.key === 'machine' ? (
                  <RouterButton
                    to="/machines"
                    search={{ add: true }}
                    size="compact-xs"
                    variant="light"
                    data-testid="onboarding-add-machine"
                  >
                    {t('web:dashboard.addMachine')}
                  </RouterButton>
                ) : (
                  machineId !== undefined && (
                    <RouterButton
                      to="/machines/$machineId"
                      params={{ machineId }}
                      size="compact-xs"
                      variant="light"
                      data-testid={`onboarding-open-${step.key}`}
                    >
                      {t('web:dashboard.onboarding.open')}
                    </RouterButton>
                  )
                ))}
            </Group>
          );
        })}
        {a !== undefined && (
          <Group gap="xs" data-testid="onboarding-access" data-ok={a.lastTest?.ok ?? 'unknown'}>
            <IconWorld size={16} />
            <Text size="sm">{t('web:dashboard.onboarding.access')}</Text>
            <Badge
              size="sm"
              variant="light"
              color={a.lastTest === null ? 'gray' : a.lastTest.ok ? 'teal' : 'red'}
            >
              {tDynamic(i18n, `web:access.modes.${a.mode}`)} ·{' '}
              {a.lastTest === null
                ? t('web:dashboard.onboarding.notTested')
                : a.lastTest.ok
                  ? t('web:access.test.ok')
                  : t('web:access.test.failed')}
            </Badge>
            {isAdmin && (
              <RouterButton
                to="/settings"
                size="compact-xs"
                variant="subtle"
                data-testid="onboarding-access-settings"
              >
                {t('web:dashboard.onboarding.configure')}
              </RouterButton>
            )}
          </Group>
        )}
      </Stack>
    </Card>
  );
}
