/**
 * Bannière « version X disponible » (admins seulement — eux seuls mettent le panel à jour).
 * L'information voyage dans `/api/auth/me` : aucune requête dédiée. Fermer la bannière la masque
 * pour CETTE version sur CE navigateur (localStorage, confort local) — la version suivante
 * la fera réapparaître.
 */
import { useState } from 'react';
import { Alert, Anchor } from '@mantine/core';
import { IconArrowUpCircle } from '@tabler/icons-react';

import { useMe } from '../api/queries.js';
import { useT } from '../i18n/hooks.js';

const RELEASES_URL = 'https://github.com/Zlababababan/MinecraftManagerOnline/releases/latest';
const DISMISS_KEY = 'mmo.updateBanner.dismissed';

function readDismissed(): string {
  try {
    return localStorage.getItem(DISMISS_KEY) ?? '';
  } catch {
    return '';
  }
}

export function UpdateBanner() {
  const { t } = useT();
  const me = useMe();
  const [dismissed, setDismissed] = useState(readDismissed);
  const update = me.data?.panelUpdate;
  if (!update || dismissed === update.latest) return null;
  return (
    <Alert
      icon={<IconArrowUpCircle size={18} />}
      color="teal"
      mb="md"
      withCloseButton
      closeButtonLabel={t('web:updateBanner.dismiss')}
      onClose={() => {
        try {
          localStorage.setItem(DISMISS_KEY, update.latest);
        } catch {
          // stockage indisponible (navigation privée…) : la bannière reviendra, tant pis.
        }
        setDismissed(update.latest);
      }}
      title={t('web:updateBanner.title', { version: update.latest })}
      data-testid="update-banner"
    >
      {t('web:updateBanner.body', { current: update.current })}{' '}
      <Anchor href={RELEASES_URL} target="_blank" rel="noreferrer">
        {t('web:updateBanner.release')}
      </Anchor>
    </Alert>
  );
}
