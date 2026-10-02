/**
 * Routeur (TanStack Router, code-based) : `/setup`, `/login`, `/s/<jeton>` (page de statut
 * publique, lot 8) publics ; tout le reste derrière
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
import { useListPrefs, type ListPrefs } from './lib/list-view.js';
import { configurePrivacy } from './lib/privacy.js';
import { AccountPage } from './pages/AccountPage.js';
import { DashboardPage } from './pages/DashboardPage.js';
import { ErrorPage } from './pages/ErrorPage.js';
import { LoginPage } from './pages/LoginPage.js';
import { MachinePage } from './pages/MachinePage.js';
import { MachinesPage } from './pages/MachinesPage.js';
import { ServersPage } from './pages/ServersPage.js';
import {
  filterToSearch,
  isServerSort,
  searchToFilter,
  type ServerFilter,
} from './lib/server-filter.js';
import { NotFoundPage } from './pages/NotFoundPage.js';
import { PublicStatusPage } from './pages/PublicStatusPage.js';
import { SERVER_TABS, ServerPage, type ServerTab } from './pages/ServerPage.js';
import { SETTINGS_SECTIONS, SettingsPage, type SettingsSection } from './pages/SettingsPage.js';
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

/**
 * Lot 8 — page de statut publique : hors de `appRoute`, donc sans session, sans Shell et sans
 * temps réel. Le jeton vient de l'URL et ne sert qu'à interroger `/api/status/:token`.
 */
const publicStatusRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/s/$token',
  component: function PublicStatusRoute() {
    const { token } = publicStatusRoute.useParams();
    return <PublicStatusPage token={token} />;
  },
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

/**
 * Vue de la flotte : les cartes par défaut (les actions sous la main — retour de Yassin, 01/10 :
 * le tableau était « moins joli » que les cartes de la page machine), le tableau pour qui veut
 * plus de serveurs à l'écran. Le choix est mémorisé par appareil.
 *
 * La clé a changé avec le défaut : l'ancienne (`servers`) enregistrait « tableau » dès qu'on
 * touchait au tri ou à la recherche, sans que personne l'ait choisi.
 */
const SERVERS_LIST_KEY = 'server-list';
const SERVERS_LIST_PREFS: ListPrefs = { mode: 'cards', sort: 'name', desc: false };

const serversRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/servers',
  // Le filtre vit dans l'URL : une vue se met en favori et se partage. `searchToFilter` est
  // tolérant par construction, un paramètre inconnu ou invalide retombe sur le défaut.
  validateSearch: (search: Record<string, unknown>) => filterToSearch(searchToFilter(search)),
  component: function ServersRoute() {
    const search = serversRoute.useSearch();
    const navigate = useNavigate();
    const [prefs, setPrefs] = useListPrefs(SERVERS_LIST_KEY, SERVERS_LIST_PREFS, isServerSort);
    const fromUrl = searchToFilter(search);
    // L'URL prime : un favori ou un lien partagé porte son propre tri. Sans tri dans l'URL,
    // on reprend celui de la dernière visite — sinon chaque passage par le menu le remet à zéro.
    const filter: ServerFilter =
      search.sort === undefined && isServerSort(prefs.sort)
        ? { ...fromUrl, sort: prefs.sort, desc: prefs.desc }
        : fromUrl;
    return (
      <ServersPage
        filter={filter}
        mode={prefs.mode}
        onModeChange={(mode) => {
          setPrefs({ mode });
        }}
        onFilterChange={(next) => {
          setPrefs({ sort: next.sort, desc: next.desc });
          void navigate({ to: '/servers', search: filterToSearch(next), replace: true });
        }}
      />
    );
  },
});

const serverRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/servers/$serverId',
  // `focus` : l'élément à mettre en avant à l'arrivée (lien de l'aperçu → champ de l'onglet).
  validateSearch: (search: Record<string, unknown>): { tab?: ServerTab; focus?: string } => ({
    ...(typeof search.tab === 'string' && (SERVER_TABS as readonly string[]).includes(search.tab)
      ? { tab: search.tab as ServerTab }
      : {}),
    ...(typeof search.focus === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(search.focus)
      ? { focus: search.focus }
      : {}),
  }),
  component: function ServerRoute() {
    const { serverId } = serverRoute.useParams();
    const { tab, focus } = serverRoute.useSearch();
    return <ServerPage serverId={serverId} tab={tab ?? 'overview'} focus={focus} />;
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
  validateSearch: (search: Record<string, unknown>): { section?: SettingsSection } =>
    typeof search.section === 'string' &&
    (SETTINGS_SECTIONS as readonly string[]).includes(search.section)
      ? { section: search.section as SettingsSection }
      : {},
  beforeLoad: ({ context }) => {
    requireRole(context.user, 'admin');
  },
  component: function SettingsRoute() {
    const { section } = settingsRoute.useSearch();
    return <SettingsPage section={section ?? 'network'} />;
  },
});

const routeTree = rootRoute.addChildren([
  setupRoute,
  loginRoute,
  publicStatusRoute,
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
