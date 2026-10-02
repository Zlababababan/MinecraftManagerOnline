/**
 * Machine hors ligne : dire ce qui se passe (retour de Yassin, 02/10 : « j'étais en train
 * d'attendre que mon PC passe en ligne et je n'ai aucun feedback visuel »).
 *
 * Le panel ne voit pas les tentatives d'un agent (c'est l'agent qui appelle), mais il sait depuis
 * quand il ne l'entend plus, et comment l'agent se comporte : il retente seul, d'abord chaque
 * seconde puis de plus en plus lentement, jusqu'à une fois par minute (doc 05 §5). D'où deux temps :
 * - les deux premières minutes : « reconnexion attendue », avec un compteur qui avance ;
 * - au-delà : ce n'est plus une attente normale, on donne le remède sur place.
 */
import { Code, Group, Loader, Stack, Text } from '@mantine/core';
import { IconPlugConnectedX } from '@tabler/icons-react';

import type { MachineDto } from '@mmo/protocol/client';

import { useT } from '../../i18n/hooks.js';
import { useNow } from '../../lib/hooks.js';
import { formatElapsed } from '../JoinStatus.js';

/** Au-delà, un agent en marche serait déjà revenu (il retente au pire une fois par minute). */
export const RECONNECT_GRACE_MS = 120_000;

export function OfflineNotice({ machine }: { machine: MachineDto }) {
  const { t } = useT();
  const now = useNow(1000);
  // Jamais vue : c'est l'appairage qui est en attente, et il a son propre écran.
  if (machine.connected || machine.lastSeenAt === null) return null;
  const since = Math.max(0, now - machine.lastSeenAt);
  const elapsed = formatElapsed(since);
  if (since < RECONNECT_GRACE_MS) {
    return (
      <Group gap={6} wrap="nowrap" data-testid="machine-offline" data-stage="waiting">
        <Loader size={12} color="yellow" />
        <Text size="xs" c="dimmed">
          {t('web:machine.offline.waiting', { elapsed })}
        </Text>
      </Group>
    );
  }
  return (
    <Stack gap={4} data-testid="machine-offline" data-stage="stuck">
      <Group gap={6} wrap="nowrap" align="flex-start">
        <IconPlugConnectedX size={14} style={{ flexShrink: 0, marginTop: 2 }} />
        <Text size="xs" className="mmo-warn-text">
          {t('web:machine.offline.stuck', { elapsed })}
        </Text>
      </Group>
      {machine.os === 'windows' && (
        <Text size="xs" c="dimmed">
          {t('web:machine.offline.windows')} <Code>Start-Service mmo-agent</Code>
        </Text>
      )}
    </Stack>
  );
}
