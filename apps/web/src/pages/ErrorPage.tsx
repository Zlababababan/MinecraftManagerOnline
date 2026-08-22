/** Erreur de chargement d'une route (réseau coupé, panel indisponible, erreur inattendue). */
import { Button, Center, Stack } from '@mantine/core';
import { useRouter } from '@tanstack/react-router';

import { ErrorAlert } from '../components/ErrorAlert.js';
import { useT } from '../i18n/hooks.js';

export function ErrorPage({ error }: { error: unknown }) {
  const { t } = useT();
  const router = useRouter();
  return (
    <Center mih="60vh" p="md">
      <Stack gap="sm" maw={480} w="100%">
        <ErrorAlert error={error} />
        <Button
          variant="light"
          onClick={() => {
            void router.invalidate();
          }}
          data-testid="route-retry"
        >
          {t('web:common.retry')}
        </Button>
      </Stack>
    </Center>
  );
}
