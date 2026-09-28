/**
 * Note discrète « à vérifier » posée à côté d'un service tiers dont l'usage n'a pas encore été
 * confirmé (conditions d'utilisation, licence, droit de télécharger directement…). Elle ne s'adresse
 * qu'aux administrateurs — c'est un pense-bête pour la personne qui tient le panel, pas un
 * avertissement pour les joueurs — et elle disparaît d'elle-même quand le service est marqué
 * vérifié dans `THIRD_PARTY_SERVICES` (`@mmo/shared`). La liste complète est dans Réglages →
 * Services tiers.
 */
import { Group, Text } from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';

import { thirdPartyToVerify, type ThirdPartyServiceId } from '@mmo/shared';

import { useMe } from '../api/queries.js';
import { useT } from '../i18n/hooks.js';
import { hasRole } from '../lib/format.js';

export function ThirdPartyNote({ services }: { services: readonly ThirdPartyServiceId[] }) {
  const { t } = useT();
  const me = useMe();
  if (me.data === undefined || !hasRole(me.data.user.role, 'admin')) return null;
  const pending = services.filter((id) => thirdPartyToVerify(id));
  if (pending.length === 0) return null;
  return (
    <Group gap={6} wrap="nowrap" align="flex-start" data-testid="third-party-note">
      <IconInfoCircle size={14} style={{ flexShrink: 0, marginTop: 3, opacity: 0.6 }} />
      <Text size="xs" c="dimmed">
        {t('web:thirdParty.notePrefix')}{' '}
        {pending.map((id) => t(`web:thirdParty.services.${id}.check`)).join(' ')}{' '}
        {t('web:thirdParty.noteSuffix')}
      </Text>
    </Group>
  );
}
