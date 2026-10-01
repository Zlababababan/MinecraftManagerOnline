/**
 * Bandeau « il faut attendre » : visible d'un coup d'œil quand le panel ne répond pas, ou vient de
 * démarrer et que ses agents ne sont pas encore reconnectés (remontée du 01/10 : une commande
 * d'installation lancée pendant le démarrage échouait sans que rien ne dise d'attendre).
 *
 * - Panel injoignable : le temps réel est coupé depuis plus de quelques secondes (une coupure d'un
 *   instant, ou le tout premier chargement, ne font pas clignoter le bandeau).
 * - Démarrage : `/api/auth/me` dit depuis combien de temps le panel tourne ; tant que c'est récent
 *   ET qu'une machine appairée est encore hors ligne, on demande d'attendre. Passé le délai, une
 *   machine hors ligne est simplement hors ligne : le bandeau disparaît.
 */
import { useEffect, useState } from 'react';
import { Alert, Loader } from '@mantine/core';

import { useMachines, useMe } from '../api/queries.js';
import { useT } from '../i18n/hooks.js';
import { useRealtimeStore } from '../store/realtime.js';

/** Durée pendant laquelle un panel « vient de démarrer ». */
export const STARTUP_WINDOW_MS = 120_000;
/** Coupure du temps réel tolérée avant de dire que le panel ne répond pas. */
export const DOWN_GRACE_MS = 4_000;

export function StartupBanner({ downGraceMs = DOWN_GRACE_MS }: { downGraceMs?: number }) {
  const { t } = useT();
  const status = useRealtimeStore((s) => s.status);
  const me = useMe();
  const machines = useMachines();
  const [now, setNow] = useState(() => Date.now());
  const [downSince, setDownSince] = useState<number | undefined>(undefined);

  // Instant (horloge du navigateur) où le panel a démarré, d'après la durée qu'il annonce.
  const uptimeMs = me.data?.uptimeMs;
  const startedAt = uptimeMs === undefined ? undefined : me.dataUpdatedAt - uptimeMs;
  const inWindow = startedAt !== undefined && now - startedAt < STARTUP_WINDOW_MS;
  const open = status === 'open';

  useEffect(() => {
    setDownSince(open ? undefined : Date.now());
  }, [open]);

  // L'heure n'avance que tant qu'un bandeau peut apparaître ou disparaître.
  const ticking = !open || inWindow;
  useEffect(() => {
    if (!ticking) return undefined;
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [ticking]);

  if (downSince !== undefined && now - downSince >= downGraceMs) {
    return (
      <Alert
        color="orange"
        mb="md"
        icon={<Loader size={18} color="orange" />}
        title={t('web:startupBanner.downTitle')}
        data-testid="startup-banner-down"
      >
        {t('web:startupBanner.downBody')}
      </Alert>
    );
  }

  const paired = (machines.data?.machines ?? []).filter(
    (m) => m.status === 'online' || m.status === 'offline',
  );
  const connected = paired.filter((m) => m.status === 'online').length;
  if (open && inWindow && connected < paired.length) {
    return (
      <Alert
        color="yellow"
        mb="md"
        icon={<Loader size={18} color="yellow" />}
        title={t('web:startupBanner.startingTitle')}
        data-testid="startup-banner-starting"
      >
        {t('web:startupBanner.startingBody', { connected, total: paired.length })}
      </Alert>
    );
  }
  return null;
}
