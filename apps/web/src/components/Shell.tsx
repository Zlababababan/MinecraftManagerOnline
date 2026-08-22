/**
 * AppShell responsive (doc 07 phase 5) : en-tête + barre latérale sur desktop, navigation basse
 * sur mobile ; thème sombre/clair/système, langue, indicateur temps réel, menu utilisateur.
 */
import {
  ActionIcon,
  AppShell,
  Burger,
  Group,
  Indicator,
  Menu,
  Stack,
  Text,
  Tooltip,
  useMantineColorScheme,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import {
  IconDeviceDesktop,
  IconLanguage,
  IconLayoutDashboard,
  IconLogout,
  IconMoon,
  IconServer2,
  IconSettings,
  IconSun,
  IconUserCircle,
  IconWorld,
} from '@tabler/icons-react';
import { Outlet, useNavigate } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useT } from '../i18n/hooks.js';

import type { UserDto } from '@mmo/protocol/client';
import { isLocale } from '@mmo/shared';

import { useAccessStatus, usePushStatus, usePushSubscribe } from '../api/phase10.js';
import { useLogout, useUpdateMe } from '../api/queries.js';
import { tDynamic } from '../i18n/index.js';
import { hasRole } from '../lib/format.js';
import { resyncPush } from '../lib/push.js';
import { NotificationCenter } from './notifications/NotificationCenter.js';
import { RouterNavLink, RouterUnstyledButton as RouterButton } from './links.js';
import { TasksIndicator } from './tasks/TaskProgress.js';
import { setLocale } from '../i18n/index.js';
import { useRealtimeStore } from '../store/realtime.js';
import { realtime } from '../ws/client.js';
import { useEffect, useRef } from 'react';

/** Phase 10 : indicateur d'accès public (mode + dernier test de joignabilité). */
export function AccessIndicator({ isAdmin }: { isAdmin: boolean }) {
  const { t, i18n } = useT();
  const navigate = useNavigate();
  const access = useAccessStatus();
  const a = access.data?.access;
  if (a === undefined) return null;
  const color = a.lastTest === null ? 'gray' : a.lastTest.ok ? 'teal' : 'red';
  const label = `${tDynamic(i18n, `web:access.modes.${a.mode}`)} · ${a.lastTest === null ? t('web:access.notListening') : a.lastTest.ok ? t('web:access.test.ok') : t('web:access.test.failed')}`;
  return (
    <Tooltip label={label} withArrow>
      <Indicator
        color={color}
        size={10}
        data-testid="access-indicator"
        data-mode={a.mode}
        data-ok={a.lastTest?.ok ?? 'unknown'}
      >
        <ActionIcon
          variant="subtle"
          color="gray"
          aria-label={t('web:access.title')}
          disabled={!isAdmin}
          onClick={() => {
            void navigate({ to: '/settings' });
          }}
        >
          <IconWorld size={18} />
        </ActionIcon>
      </Indicator>
    </Tooltip>
  );
}

/** Phase 10 : re-synchronisation des abonnements push au démarrage (iOS purge silencieusement). */
function PushResync() {
  const push = usePushStatus();
  const subscribe = usePushSubscribe();
  const done = useRef(false);
  const vapid = push.data?.vapidPublicKey;
  useEffect(() => {
    if (done.current || vapid === undefined) return;
    done.current = true;
    void resyncPush(vapid, (input) => subscribe.mutateAsync(input)).catch(() => undefined);
  }, [vapid, subscribe]);
  return null;
}

export function RealtimeIndicator() {
  const { t } = useT();
  const status = useRealtimeStore((s) => s.status);
  const color = status === 'open' ? 'teal' : status === 'connecting' ? 'yellow' : 'red';
  return (
    <Tooltip label={t(`web:realtime.${status}`)} withArrow>
      <Indicator
        color={color}
        processing={status !== 'open'}
        size={10}
        data-testid="realtime"
        data-status={status}
      >
        <Text size="xs" c="dimmed" visibleFrom="sm">
          {t(`web:realtime.${status}`)}
        </Text>
      </Indicator>
    </Tooltip>
  );
}

export function ThemeMenu({ onChange }: { onChange?: (theme: string) => void }) {
  const { t } = useT();
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const icon =
    colorScheme === 'dark' ? (
      <IconMoon size={18} />
    ) : colorScheme === 'light' ? (
      <IconSun size={18} />
    ) : (
      <IconDeviceDesktop size={18} />
    );
  const pick = (value: 'light' | 'dark' | 'auto'): void => {
    setColorScheme(value);
    onChange?.(value);
  };
  return (
    <Menu shadow="md" width={160}>
      <Menu.Target>
        <ActionIcon
          variant="subtle"
          color="gray"
          aria-label={t('web:theme.label')}
          data-testid="theme-menu"
        >
          {icon}
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>{t('web:theme.label')}</Menu.Label>
        <Menu.Item
          leftSection={<IconSun size={16} />}
          onClick={() => {
            pick('light');
          }}
          data-testid="theme-light"
        >
          {t('web:theme.light')}
        </Menu.Item>
        <Menu.Item
          leftSection={<IconMoon size={16} />}
          onClick={() => {
            pick('dark');
          }}
          data-testid="theme-dark"
        >
          {t('web:theme.dark')}
        </Menu.Item>
        <Menu.Item
          leftSection={<IconDeviceDesktop size={16} />}
          onClick={() => {
            pick('auto');
          }}
        >
          {t('web:theme.auto')}
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}

export function LanguageMenu({ onChange }: { onChange?: (locale: 'fr' | 'en') => void }) {
  const { t } = useT();
  const pick = (value: 'fr' | 'en'): void => {
    setLocale(value);
    onChange?.(value);
  };
  return (
    <Menu shadow="md" width={160}>
      <Menu.Target>
        <ActionIcon
          variant="subtle"
          color="gray"
          aria-label={t('web:lang.label')}
          data-testid="lang-menu"
        >
          <IconLanguage size={18} />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>{t('web:lang.label')}</Menu.Label>
        <Menu.Item
          onClick={() => {
            pick('fr');
          }}
          data-testid="lang-fr"
        >
          {t('web:lang.fr')}
        </Menu.Item>
        <Menu.Item
          onClick={() => {
            pick('en');
          }}
          data-testid="lang-en"
        >
          {t('web:lang.en')}
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}

type NavTo = '/' | '/machines' | '/account' | '/settings';

function NavItems({ onNavigate, isAdmin }: { onNavigate?: () => void; isAdmin: boolean }) {
  const { t } = useT();
  const items: { to: NavTo; label: string; icon: ReactNode }[] = [
    { to: '/', label: t('web:nav.dashboard'), icon: <IconLayoutDashboard size={18} /> },
    { to: '/machines', label: t('web:nav.machines'), icon: <IconServer2 size={18} /> },
    { to: '/account', label: t('web:nav.account'), icon: <IconUserCircle size={18} /> },
    ...(isAdmin
      ? [
          {
            to: '/settings' as const,
            label: t('web:nav.settings'),
            icon: <IconSettings size={18} />,
          },
        ]
      : []),
  ];
  return (
    <Stack gap={4}>
      {items.map((item) => (
        <RouterNavLink
          key={item.to}
          to={item.to}
          label={item.label}
          leftSection={item.icon}
          activeOptions={{ exact: item.to === '/' }}
          activeProps={{ active: true }}
          {...(onNavigate === undefined ? {} : { onClick: onNavigate })}
          data-testid={`nav-${item.to === '/' ? 'dashboard' : item.to.slice(1)}`}
        />
      ))}
    </Stack>
  );
}

function BottomNav({ isAdmin }: { isAdmin: boolean }) {
  const { t } = useT();
  const items: { to: NavTo; label: string; icon: ReactNode }[] = [
    { to: '/', label: t('web:nav.dashboard'), icon: <IconLayoutDashboard size={22} /> },
    { to: '/machines', label: t('web:nav.machines'), icon: <IconServer2 size={22} /> },
    { to: '/account', label: t('web:nav.account'), icon: <IconUserCircle size={22} /> },
    ...(isAdmin
      ? [
          {
            to: '/settings' as const,
            label: t('web:nav.settings'),
            icon: <IconSettings size={22} />,
          },
        ]
      : []),
  ];
  return (
    <Group grow gap={0} h="100%" data-testid="bottom-nav">
      {items.map((item) => (
        <RouterButton
          key={item.to}
          to={item.to}
          activeOptions={{ exact: item.to === '/' }}
          activeProps={{ 'data-active': true }}
          style={{ height: '100%' }}
          data-testid={`bottomnav-${item.to === '/' ? 'dashboard' : item.to.slice(1)}`}
        >
          <Stack gap={2} align="center" justify="center" h="100%" className="mmo-bottomnav-item">
            {item.icon}
            <Text size="xs">{item.label}</Text>
          </Stack>
        </RouterButton>
      ))}
    </Group>
  );
}

export function Shell({ user }: { user: UserDto }) {
  const { t } = useT();
  const [opened, { toggle, close }] = useDisclosure(false);
  const navigate = useNavigate();
  const logout = useLogout();
  const updateMe = useUpdateMe();
  const isAdmin = hasRole(user.role, 'admin');

  const onLogout = (): void => {
    realtime.disconnect();
    useRealtimeStore.getState().reset();
    logout.mutate(undefined, {
      onSettled: () => {
        void navigate({ to: '/login' });
      },
    });
  };

  return (
    <AppShell
      header={{ height: 56 }}
      navbar={{ width: 230, breakpoint: 'sm', collapsed: { mobile: !opened } }}
      footer={{ height: { base: 60, sm: 0 } }}
      padding="md"
    >
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between" wrap="nowrap">
          <Group gap="sm" wrap="nowrap">
            <Burger
              opened={opened}
              onClick={toggle}
              hiddenFrom="sm"
              size="sm"
              aria-label={t('web:nav.menu')}
            />
            <RouterButton to="/" data-testid="brand">
              <Text fw={700} size="lg">
                {t('web:app.short')}
              </Text>
            </RouterButton>
            <Text c="dimmed" size="sm" visibleFrom="md">
              {t('web:app.name')}
            </Text>
          </Group>
          <Group gap="xs" wrap="nowrap">
            <PushResync />
            <TasksIndicator />
            <AccessIndicator isAdmin={isAdmin} />
            <RealtimeIndicator />
            <NotificationCenter />
            <ThemeMenu
              onChange={(theme) => {
                updateMe.mutate({ theme });
              }}
            />
            <LanguageMenu
              onChange={(locale) => {
                if (isLocale(locale) && locale !== user.locale) updateMe.mutate({ locale });
              }}
            />
            <Menu shadow="md" width={200}>
              <Menu.Target>
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  aria-label={user.username}
                  data-testid="user-menu"
                >
                  <IconUserCircle size={20} />
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Label>
                  {user.username} · {t(`web:role.${user.role}`)}
                </Menu.Label>
                <Menu.Item
                  leftSection={<IconUserCircle size={16} />}
                  onClick={() => {
                    void navigate({ to: '/account' });
                  }}
                >
                  {t('web:nav.account')}
                </Menu.Item>
                {isAdmin && (
                  <Menu.Item
                    leftSection={<IconSettings size={16} />}
                    onClick={() => {
                      void navigate({ to: '/settings' });
                    }}
                    data-testid="menu-settings"
                  >
                    {t('web:nav.settings')}
                  </Menu.Item>
                )}
                <Menu.Item
                  leftSection={<IconLogout size={16} />}
                  onClick={onLogout}
                  data-testid="logout"
                >
                  {t('web:nav.logout')}
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </Group>
        </Group>
      </AppShell.Header>
      <AppShell.Navbar p="sm">
        <NavItems onNavigate={close} isAdmin={isAdmin} />
      </AppShell.Navbar>
      <AppShell.Main>
        <Outlet />
      </AppShell.Main>
      <AppShell.Footer hiddenFrom="sm" p={0}>
        <BottomNav isAdmin={isAdmin} />
      </AppShell.Footer>
    </AppShell>
  );
}
