/** Service worker (vite-plugin-pwa) : notification de mise à jour et de disponibilité hors ligne. */
import { Button } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useEffect } from 'react';
import { useT } from './i18n/hooks.js';
import { useRegisterSW } from 'virtual:pwa-register/react';

export function PwaUpdater() {
  const { t } = useT();
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    offlineReady: [offlineReady, setOfflineReady],
    updateServiceWorker,
  } = useRegisterSW();

  useEffect(() => {
    if (!offlineReady) return;
    notifications.show({ color: 'teal', message: t('web:pwa.offlineReady'), autoClose: 4000 });
    setOfflineReady(false);
  }, [offlineReady, setOfflineReady, t]);

  useEffect(() => {
    if (!needRefresh) return;
    notifications.show({
      id: 'pwa-update',
      color: 'blue',
      autoClose: false,
      message: (
        <>
          {t('web:pwa.updateAvailable')}{' '}
          <Button
            size="compact-xs"
            variant="light"
            onClick={() => {
              void updateServiceWorker(true);
            }}
          >
            {t('web:pwa.reload')}
          </Button>
        </>
      ),
      onClose: () => {
        setNeedRefresh(false);
      },
    });
  }, [needRefresh, setNeedRefresh, t, updateServiceWorker]);

  return null;
}
