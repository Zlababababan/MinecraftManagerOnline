/**
 * Routeur (TanStack Router, code-based) : `/setup`, `/login` publics ; tout le reste derrière
 * `requireUser` (401 → `/login`, ou `/setup` si `details.setupRequired`). Gardes par rôle via
 * `requireRole`. Les données de session viennent du cache TanStack Query (`meQuery`).
 */
import type { QueryClient } from '@tanstack/react-query';
import {
  Outlet,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  isRedirect,
  redirect,
  useNavigate,
  useRouteContext,
  type RouterHistory,
} from '@tanstack/react-router';
import { useEffect } from 'react';

import type { Role, UserDto } from '@mmo/protocol/client';

import { ApiRequestError } from './api/client.js';
import { meQuery, setupStatusQuery, useMe } from './api/queries.js';
import { Shell } from './components/Shell.js';
import { setLocale } from './i18n/index.js';
import { hasRole } from './lib/format.js';
import { configurePrivacy } from './lib/privacy.js';
import { AccountPage } from './pages/AccountPage.js';
import { DashboardPage } from './pages/DashboardPage.js';
import { ErrorPage } from './pages/ErrorPage.js';
import { LoginPage } from './pages/LoginPage.js';
import { MachinePage } from './pages/MachinePage.js';
import { MachinesPage } from './pages/MachinesPage.js';
import { ServersPage } from './pages/ServersPage.js';
import { filterToSearch, searchToFilter } from './lib/server-filter.js';
import { NotFoundPage } from './pages/NotFoundPage.js';
import { SERVER_TABS, ServerPage, type ServerTab } from './pages/ServerPage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { SetupPage } from './pages/SetupPage.js';
import { bindRealtime } from './store/realtime.js';
import { realtime } from './ws/client.js';

export interface RouterContext {
  queryClient: QueryClient;
}

async function requireUser(queryClient: QueryClient, href: string): Promise<UserDto> {
  try {
    const { user, privacy } = await queryClient.ensureQueryData(meQuery);
    // Vie privée (lot 9) : connu avant le premier rendu d'un joueur, sans hook dans l'avatar.
    configurePrivacy(privacy);
    return user;
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 401) {
      if (error.setupRequired) throw redirect({ to: '/setup' });
      throw redirect({ to: '/login', search: { redirect: href } });
    }
    throw error;
  }
}

export function requireRole(user: UserDto, role: Role): void {
  if (!hasRole(user.role, role)) throw redirect({ to: '/' });
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: () => <Outlet />,
  notFoundComponent: NotFoundPage,
  errorComponent: ({ error }) => <ErrorPage error={error} />,
});

const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/setup',
  beforeLoad: async ({ context }) => {
    const status = await context.queryClient.fetchQuery(setupStatusQuery);
    if (!status.needsSetup) throw redirect({ to: '/login' });
  },
  component: SetupPage,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  validateSearch: (search: Record<string, unknown>): { redirect?: string } =>
    typeof search.redirect === 'string' ? { redirect: search.redirect } : {},
  beforeLoad: async ({ context }) => {
    const status = await context.queryClient.fetchQuery(setupStatusQuery);
    if (status.needsSetup) throw redirect({ to: '/setup' });
    try {
      await context.queryClient.ensureQueryData(meQuery);
    } catch (error) {
      if (isRedirect(error)) throw error;
      return; // pas de session : afficher le formulaire
    }
    throw redirect({ to: '/' });
  },
  component: LoginPage,
});

function AppLayout() {
  const { queryClient } = useRouteContext({ from: '__root__' });
  const me = useMe();
  const user = me.data?.user;
  useEffect(() => {
    const unbind = bindRealtime(realtime, queryClient);
    realtime.connect();
    return () => {
      unbind();
    };
  }, [queryClient]);
  useEffect(() => {
    if (user !== undefined) setLocale(user.locale);
  }, [user?.locale, user]);
  if (user === undefined) return null;
  return <Shell user={user} />;
}

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'app',
  beforeLoad: async ({ context, location }) => ({
    user: await requireUser(context.queryClient, location.href),
  }),
  component: AppLayout,
});

const indexRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/',
  component: DashboardPage,
});

const serversRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/servers',
  // Le filtre vit dans l'URL : une vue se met en favori et se partage. `searchToFilter` est
  // tolérant par construction, un paramètre inconnu ou invalide retombe sur le défaut.
  validateSearch: (search: Record<string, unknown>) => filterToSearch(searchToFilter(search)),
  component: function ServersRoute() {
    const search = serversRoute.useSearch();
    const navigate = useNavigate();
    return (
      <ServersPage
        filter={searchToFilter(search)}
        onFilterChange={(next) => {
          void navigate({ to: '/servers', search: filterToSearch(next), replace: true });
        }}
      />
    );
  },
});

const serverRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/servers/$serverId',
  validateSearch: (search: Record<string, unknown>): { tab?: ServerTab } =>
    typeof search.tab === 'string' && (SERVER_TABS as readonly string[]).includes(search.tab)
      ? { tab: search.tab as ServerTab }
      : {},
  component: function ServerRoute() {
    const { serverId } = serverRoute.useParams();
    const { tab } = serverRoute.useSearch();
    return <ServerPage serverId={serverId} tab={tab ?? 'overview'} />;
  },
});

const machinesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/machines',
  validateSearch: (search: Record<string, unknown>): { add?: boolean } =>
    search.add === true || search.add === 'true' ? { add: true } : {},
  beforeLoad: ({ context, search }) => {
    // Ouverture directe du formulaire d'ajout : admin uniquement.
    if (search.add === true && !hasRole(context.user.role, 'admin')) {
      throw redirect({ to: '/machines', search: {} });
    }
  },
  component: function MachinesRoute() {
    const { add } = machinesRoute.useSearch();
    return <MachinesPage openAdd={add === true} />;
  },
});

const machineRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/machines/$machineId',
  component: function MachineRoute() {
    const { machineId } = machineRoute.useParams();
    return <MachinePage machineId={machineId} />;
  },
});

const accountRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/account',
  component: function AccountRoute() {
    const me = useMe();
    if (me.data === undefined) return null;
    return <AccountPage user={me.data.user} />;
  },
});

const settingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/settings',
  beforeLoad: ({ context }) => {
    requireRole(context.user, 'admin');
  },
  component: SettingsPage,
});

const routeTree = rootRoute.addChildren([
  setupRoute,
  loginRoute,
  appRoute.addChildren([
    indexRoute,
    serversRoute,
    serverRoute,
    machinesRoute,
    machineRoute,
    accountRoute,
    settingsRoute,
  ]),
]);

export function createAppRouter(queryClient: QueryClient, history?: RouterHistory) {
  return createRouter({
    routeTree,
    ...(history === undefined ? {} : { history }),
    context: { queryClient },
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 0,
    scrollRestoration: true,
  });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
