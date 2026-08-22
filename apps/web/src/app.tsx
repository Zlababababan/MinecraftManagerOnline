/** Racine React : Mantine (thème sombre natif, clair/système), Query, Modals, Notifications, Router. */
import {
  CloseButton,
  DEFAULT_THEME,
  MantineProvider,
  createTheme,
  localStorageColorSchemeManager,
  type MantineColorsTuple,
} from '@mantine/core';
import { ModalsProvider } from '@mantine/modals';
import { Notifications } from '@mantine/notifications';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, type RouterHistory } from '@tanstack/react-router';
import { useState } from 'react';

import { ApiRequestError } from './api/client.js';
import { PwaUpdater } from './pwa.js';
import { useT } from './i18n/hooks.js';
import { createAppRouter } from './router.js';

export const theme = createTheme({
  primaryColor: 'teal',
  // Phase 12 (accessibilité) : teal-9 pour les fonds « filled » (blanc ≥ 4,5:1), texte noir
  // automatique sur les badges clairs (vert/jaune/gris), `dimmed` relevé dans styles.css.
  primaryShade: 9,
  autoContrast: true,
  luminanceThreshold: 0.2,
  // green-9 (#2b8a3e) et teal-9 (#087f5b, variante « light » sur fond teal-0) restent sous 4,5:1 :
  // nuance 9 assombrie (blanc 5,4:1 / 6,4:1 ; texte teal sur fond clair 5,6:1).
  colors: {
    green: [...DEFAULT_THEME.colors.green.slice(0, 9), '#237a35'] as unknown as MantineColorsTuple,
    teal: [...DEFAULT_THEME.colors.teal.slice(0, 9), '#066e4f'] as unknown as MantineColorsTuple,
  },
  defaultRadius: 'md',
  fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
});

export const colorSchemeManager = localStorageColorSchemeManager({ key: 'mmo.theme' });

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: (count, error) =>
          !(error instanceof ApiRequestError && error.status < 500) && count < 2,
        refetchOnWindowFocus: true,
        staleTime: 10_000,
      },
    },
  });
}

export function App({
  queryClient,
  pwa = true,
  history,
}: {
  queryClient?: QueryClient;
  pwa?: boolean;
  /** Historique mémoire (tests). */
  history?: RouterHistory;
}) {
  const [client] = useState(() => queryClient ?? createQueryClient());
  const [router] = useState(() => createAppRouter(client, history));
  const { t } = useT();
  // Accessibilité (phase 12) : tout bouton de fermeture Mantine (notifications, modales, drawers)
  // porte un nom — « Fermer »/« Close » selon la langue courante.
  const localizedTheme = createTheme({
    ...theme,
    components: {
      CloseButton: CloseButton.extend({
        defaultProps: { 'aria-label': t('web:common.close') } as Record<string, unknown>,
      }),
    },
  });
  return (
    <MantineProvider
      theme={localizedTheme}
      defaultColorScheme="dark"
      colorSchemeManager={colorSchemeManager}
    >
      <QueryClientProvider client={client}>
        <ModalsProvider>
          <Notifications position="top-right" />
          {pwa && <PwaUpdater />}
          <RouterProvider router={router} />
        </ModalsProvider>
      </QueryClientProvider>
    </MantineProvider>
  );
}
