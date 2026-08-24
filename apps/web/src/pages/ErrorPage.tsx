/** Erreur de chargement d'une route (réseau coupé, panel indisponible, erreur inattendue). */
import { Alert, Button, Center, Stack } from '@mantine/core';
import { useRouter } from '@tanstack/react-router';

import { ErrorAlert } from '../components/ErrorAlert.js';
import { useT } from '../i18n/hooks.js';
import { isChunkLoadError } from '../lib/chunk-reload.js';

export function ErrorPage({ error }: { error: unknown }) {
  const { t } = useT();
  const router = useRouter();
  // Chunk introuvable = le panel a été mis à jour pendant que cette version tournait :
  // seul un rechargement complet charge la nouvelle version (réessayer l'import est sans espoir).
  const stale = isChunkLoadError(error);
  return (
    <Center mih="60vh" p="md">
      <Stack gap="sm" maw={480} w="100%">
        {stale ? (
          <Alert color="blue" variant="light" data-testid="stale-version">
            {t('web:common.staleVersion')}
          </Alert>
        ) : (
          <ErrorAlert error={error} />
        )}
        <Button
          variant="light"
          onClick={() => {
            if (stale) {
              window.location.reload();
              return;
            }
            void router.invalidate();
          }}
          data-testid="route-retry"
        >
          {stale ? t('web:common.reload') : t('web:common.retry')}
        </Button>
      </Stack>
    </Center>
  );
}
