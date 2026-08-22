/**
 * Phase 10 — page Compte : préférences par type d'événement (`notification_prefs`) et push sur cet
 * appareil (détection du support, onboarding iOS « écran d'accueil », activation/désactivation,
 * appareils enregistrés, push de test).
 */
import { Alert, Badge, Button, Card, Group, List, Stack, Switch, Text, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconBellRinging, IconDeviceMobile } from '@tabler/icons-react';
import { useState } from 'react';

import { NOTIFICATION_TYPES, type NotificationType } from '@mmo/protocol/client';

import {
  useNotificationPrefs,
  usePushStatus,
  usePushSubscribe,
  usePushTest,
  usePushUnsubscribe,
  useSetNotificationPrefs,
} from '../../api/phase10.js';
import { useT } from '../../i18n/hooks.js';
import { tDynamic } from '../../i18n/index.js';
import { describeError } from '../../lib/errors.js';
import { formatDateTime } from '../../lib/format.js';
import {
  pushSupport,
  subscribePush,
  unsubscribePush,
  currentSubscription,
  type PushSupport,
} from '../../lib/push.js';

export function NotificationPrefsCard() {
  const { t, i18n } = useT();
  const prefs = useNotificationPrefs();
  const set = useSetNotificationPrefs();
  return (
    <Card withBorder radius="md" padding="md" data-testid="notification-prefs">
      <Stack gap="sm">
        <Title order={4}>{t('web:notifications.prefsTitle')}</Title>
        <Text size="sm" c="dimmed">
          {t('web:notifications.prefsHint')}
        </Text>
        {NOTIFICATION_TYPES.map((type: NotificationType) => (
          <Switch
            key={type}
            label={tDynamic(i18n, `web:notifications.types.${type.replace('.', '_')}`)}
            checked={prefs.data?.prefs[type] ?? false}
            disabled={prefs.data === undefined}
            onChange={(event) => {
              set.mutate({ [type]: event.currentTarget.checked });
            }}
            data-testid={`pref-${type}`}
          />
        ))}
      </Stack>
    </Card>
  );
}

/** Injection du support (tests) : par défaut, détection réelle du navigateur. */
export function PushCard({ support: supportOverride }: { support?: PushSupport }) {
  const { t, i18n } = useT();
  const status = usePushStatus();
  const subscribe = usePushSubscribe();
  const unsubscribe = usePushUnsubscribe();
  const test = usePushTest();
  const [support, setSupport] = useState<PushSupport>(() => supportOverride ?? pushSupport());
  const [thisDevice, setThisDevice] = useState<boolean | undefined>(undefined);
  const vapid = status.data?.vapidPublicKey ?? null;

  if (thisDevice === undefined && support.supported && supportOverride === undefined) {
    setThisDevice(false);
    void currentSubscription().then((sub) => {
      setThisDevice(sub !== undefined);
    });
  }

  const enable = async (): Promise<void> => {
    if (vapid === null) return;
    try {
      const input = await subscribePush(vapid);
      await subscribe.mutateAsync(input);
      setThisDevice(true);
      setSupport(supportOverride ?? pushSupport());
      notifications.show({ color: 'teal', message: t('web:notifications.push.enabled') });
    } catch (error) {
      const denied = error instanceof Error && error.message === 'permission denied';
      notifications.show({
        color: 'red',
        message: denied ? t('web:notifications.push.permissionDenied') : describeError(i18n, error),
      });
      setSupport(supportOverride ?? pushSupport());
    }
  };
  const disable = async (): Promise<void> => {
    const endpoint = await unsubscribePush();
    if (endpoint !== undefined) await unsubscribe.mutateAsync(endpoint);
    setThisDevice(false);
    notifications.show({ color: 'gray', message: t('web:notifications.push.disabled') });
  };

  return (
    <Card withBorder radius="md" padding="md" data-testid="push-card">
      <Stack gap="sm">
        <Group gap="xs">
          <IconBellRinging size={18} />
          <Title order={4}>{t('web:notifications.push.title')}</Title>
        </Group>
        <Text size="sm" c="dimmed">
          {t('web:notifications.push.hint')}
        </Text>
        {vapid === null && status.data !== undefined && (
          <Alert color="yellow" data-testid="push-unavailable">
            {t('web:notifications.push.unavailable')}
          </Alert>
        )}
        {support.reason === 'ios-not-installed' && (
          <Alert
            color="blue"
            icon={<IconDeviceMobile size={18} />}
            title={t('web:notifications.push.ios.title')}
            data-testid="push-ios-onboarding"
          >
            <Stack gap={4}>
              <Text size="sm">{t('web:notifications.push.ios.intro')}</Text>
              <List size="sm" type="ordered">
                <List.Item>{t('web:notifications.push.ios.step1')}</List.Item>
                <List.Item>{t('web:notifications.push.ios.step2')}</List.Item>
                <List.Item>{t('web:notifications.push.ios.step3')}</List.Item>
              </List>
            </Stack>
          </Alert>
        )}
        {support.reason !== undefined && support.reason !== 'ios-not-installed' && (
          <Alert color="gray" data-testid={`push-unsupported-${support.reason}`}>
            {tDynamic(i18n, `web:notifications.push.unsupported.${support.reason}`)}
          </Alert>
        )}
        {support.supported && support.ios && support.standalone && (
          <Text size="xs" c="teal">
            {t('web:notifications.push.ios.installed')}
          </Text>
        )}
        {support.supported && support.permission === 'denied' && (
          <Alert color="red">{t('web:notifications.push.permissionDenied')}</Alert>
        )}
        <Group>
          {thisDevice === true ? (
            <Button
              type="button"
              variant="default"
              onClick={() => {
                void disable();
              }}
              loading={unsubscribe.isPending}
              data-testid="push-disable"
            >
              {t('web:notifications.push.disable')}
            </Button>
          ) : (
            <Button
              type="button"
              onClick={() => {
                void enable();
              }}
              disabled={!support.supported || vapid === null || support.permission === 'denied'}
              loading={subscribe.isPending}
              data-testid="push-enable"
            >
              {t('web:notifications.push.enable')}
            </Button>
          )}
          <Button
            type="button"
            variant="light"
            disabled={(status.data?.subscriptions.length ?? 0) === 0}
            loading={test.isPending}
            onClick={() => {
              test.mutate(undefined, {
                onSuccess: (r) => {
                  notifications.show({
                    color: 'teal',
                    message: t('web:notifications.push.testSent', r),
                  });
                },
                onError: (error) => {
                  notifications.show({ color: 'red', message: describeError(i18n, error) });
                },
              });
            }}
            data-testid="push-test"
          >
            {t('web:notifications.push.test')}
          </Button>
        </Group>
        <Title order={6}>{t('web:notifications.push.devices')}</Title>
        {(status.data?.subscriptions.length ?? 0) === 0 ? (
          <Text size="sm" c="dimmed" data-testid="push-no-devices">
            {t('web:notifications.push.noDevices')}
          </Text>
        ) : (
          <Stack gap={4} data-testid="push-devices">
            {status.data?.subscriptions.map((s) => (
              <Group key={s.id} gap="xs" wrap="nowrap">
                <Text size="sm" style={{ flex: 1 }} truncate>
                  {s.userAgent ?? s.endpoint}
                </Text>
                <Text size="xs" c="dimmed">
                  {t('web:notifications.push.lastSuccess')}:{' '}
                  {s.lastSuccessAt === null
                    ? t('web:notifications.push.never')
                    : formatDateTime(s.lastSuccessAt, i18n.language)}
                </Text>
                {s.failCount > 0 && (
                  <Badge color="red" size="xs">
                    {t('web:notifications.push.failures', { count: s.failCount })}
                  </Badge>
                )}
              </Group>
            ))}
          </Stack>
        )}
      </Stack>
    </Card>
  );
}
