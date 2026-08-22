/** Racine React : Mantine (thème sombre natif, clair/système), Query, Modals, Notifications, Router. */
import { MantineProvider, createTheme, localStorageColorSchemeManager } from '@mantine/core';
import { ModalsProvider } from '@mantine/modals';
import { Notifications } from '@mantine/notifications';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, type RouterHistory } from '@tanstack/react-router';
import { useState } from 'react';

import { ApiRequestError } from './api/client.js';
import { PwaUpdater } from './pwa.js';
import { createAppRouter } from './router.js';

export const theme = createTheme({
  primaryColor: 'teal',
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
  return (
    <MantineProvider
      theme={theme}
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
