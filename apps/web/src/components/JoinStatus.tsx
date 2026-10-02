/**
 * « Peut-on rejoindre le serveur ? » — dit en clair (demande de Yassin, 02/10 : un modpack comme
 * All the Mods met plusieurs minutes à se lancer, et le badge seul ne le disait pas).
 *
 * L'agent sait quand le monde est chargé : il attend la ligne `Done (…)!` de la console (ou une
 * authentification RCON réussie) avant de passer le serveur de « starting » à « running ». On
 * affiche donc le temps écoulé pendant le démarrage, puis « prêt » dès que l'état bascule.
 *
 * « Prêt » écrit l'adresse à taper, PORT COMPRIS (retour du 02/10 : un serveur sur 25570, tapé sans
 * port, restait invisible dans Minecraft). L'adresse n'est demandée au panel que pour un serveur en
 * marche — jamais pour toutes les cartes d'une liste.
 */
import { Group, Loader, Text } from '@mantine/core';
import { IconCircleCheck } from '@tabler/icons-react';

import type { ServerDto } from '@mmo/protocol/client';

import { useServerAddress } from '../api/phase10.js';
import { useT } from '../i18n/hooks.js';
import { useNow } from '../lib/hooks.js';
import { SensitiveSentence } from './Sensitive.js';

/** `45 s`, `2 min 05` : à la seconde, parce qu'on regarde ce compteur en attendant. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes === 0
    ? `${String(seconds)} s`
    : `${String(minutes)} min ${String(seconds).padStart(2, '0')}`;
}

function Starting({ startedAt }: { startedAt: number | null }) {
  const { t } = useT();
  const now = useNow(1000);
  return (
    <Group gap={6} wrap="nowrap" data-testid="join-status" data-ready="false">
      <Loader size={12} color="yellow" />
      <Text size="xs" c="dimmed">
        {startedAt === null
          ? t('web:server.join.starting')
          : t('web:server.join.startingSince', { elapsed: formatElapsed(now - startedAt) })}
      </Text>
    </Group>
  );
}

function Ready({ serverId }: { serverId: string }) {
  const { t } = useT();
  const address = useServerAddress(serverId).data?.address.address ?? null;
  return (
    <Group gap={6} wrap="nowrap" data-testid="join-status" data-ready="true">
      <IconCircleCheck size={14} color="var(--mantine-color-green-5)" style={{ flexShrink: 0 }} />
      <Text size="xs" c="green.5" style={{ wordBreak: 'break-all' }}>
        {/* Adresse inconnue (ou pas encore reçue) : on dit « prêt » sans rien inventer. */}
        {address === null ? (
          t('web:server.join.ready')
        ) : (
          <SensitiveSentence
            value={address}
            render={(v) => t('web:server.join.readyAt', { address: v })}
          />
        )}
      </Text>
    </Group>
  );
}

export function JoinStatus({ server }: { server: ServerDto }) {
  // Agent hors ligne : l'état affiché date, on ne promet rien.
  if (!server.reachable) return null;
  if (server.runState === 'starting') return <Starting startedAt={server.startedAt} />;
  if (server.runState !== 'running') return null;
  return <Ready serverId={server.id} />;
}
