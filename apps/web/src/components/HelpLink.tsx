/**
 * Aide contextuelle (lot 7) : une icône qui ouvre la section du guide utilisateur dans la langue
 * de l'interface, avec repli anglais. La table langue → chemin vit ici et nulle part ailleurs —
 * les noms de fichiers des guides ne sont PAS uniformes entre langues (seul le français les
 * traduit), on ne peut donc pas construire l'URL par interpolation.
 */
import { ActionIcon, Anchor, Group, Tooltip } from '@mantine/core';
import { IconExternalLink, IconHelp } from '@tabler/icons-react';

import type { Locale } from '@mmo/shared';

import { useT } from '../i18n/hooks.js';
import { currentLocale } from '../i18n/index.js';

const GUIDE_BASE = 'https://github.com/Zlababababan/MinecraftManagerOnline/blob/main/docs/guide/';

/** `en` est obligatoire (version canonique, à la racine de docs/guide) et sert de repli. */
type GuideLinks = Partial<Record<Locale, string>> & { en: string };

export const HELP_TOPICS = {
  pairing: {
    en: 'add-a-machine.md#1-create-the-machine-and-get-the-command',
    fr: 'fr/ajouter-une-machine.md#1-créer-la-machine-et-obtenir-la-commande',
  },
  access: {
    en: 'network-faq.md',
    fr: 'fr/faq-reseau.md',
  },
  publicUrl: {
    en: 'installation.md#3-remote-access-summary',
    fr: 'fr/installation.md#3-accès-distant-résumé',
  },
  java: {
    en: 'add-a-machine.md#2-detect-servers',
    fr: 'fr/ajouter-une-machine.md#2-détecter-les-serveurs',
  },
  backups: {
    en: 'add-a-machine.md#7-backups',
    fr: 'fr/ajouter-une-machine.md#7-sauvegardes',
  },
  /** Lot 9 : ce que le panel conserve sur les personnes, et ses appels sortants. */
  privacy: {
    en: 'installation.md#5-what-the-panel-keeps-and-who-it-talks-to',
    fr: 'fr/installation.md#5-ce-que-le-panel-conserve-et-à-qui-il-parle',
  },
  /** Lot 4 : webhooks Discord et JSON signé — configuration, refus, vérification de la signature. */
  webhooks: {
    en: 'installation.md#6-webhooks-discord-and-signed-json',
    fr: 'fr/installation.md#6-webhooks-discord-et-json-signé',
  },
  /** Lot 8 : clés d'API — rôle, expiration, en-tête Bearer, ce qu'une clé ne peut pas faire. */
  apiKeys: {
    en: 'add-a-machine.md#12-api-keys',
    fr: 'fr/ajouter-une-machine.md#12-clés-dapi',
  },
  /** Lot 8 : page de statut publique — lien à partager, ce qu'elle montre, opt-in nominatif. */
  statusPage: {
    en: 'add-a-machine.md#14-a-public-status-page-for-friends',
    fr: 'fr/ajouter-une-machine.md#14-une-page-de-statut-publique-pour-les-amis',
  },
  /** Lot 8 : demandes de whitelist en libre-service — accepter, refuser, oublier. */
  whitelistRequests: {
    en: 'add-a-machine.md#15-letting-friends-ask-for-access-whitelist',
    fr: 'fr/ajouter-une-machine.md#15-laisser-vos-amis-demander-laccès-whitelist',
  },
  /** Lot 8 : appareils connectés — voir et déconnecter ses sessions. */
  sessions: {
    en: 'add-a-machine.md#13-signed-in-devices',
    fr: 'fr/ajouter-une-machine.md#13-appareils-connectés',
  },
} satisfies Record<string, GuideLinks>;

export type HelpTopic = keyof typeof HELP_TOPICS;

export function helpUrl(topic: HelpTopic, locale: Locale): string {
  const links: GuideLinks = HELP_TOPICS[topic];
  return GUIDE_BASE + (links[locale] ?? links.en);
}

export function HelpLink({ topic, inline }: { topic: HelpTopic; inline?: boolean }) {
  const { t } = useT();
  const href = helpUrl(topic, currentLocale());
  if (inline === true) {
    return (
      <Anchor
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        size="sm"
        data-testid={`help-${topic}`}
      >
        <Group gap={4} component="span" display="inline-flex">
          {t('web:common.helpGuide')} <IconExternalLink size={12} />
        </Group>
      </Anchor>
    );
  }
  return (
    <Tooltip label={t('web:common.helpGuide')} withArrow>
      <ActionIcon
        component="a"
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        variant="subtle"
        color="gray"
        size="sm"
        aria-label={t('web:common.helpGuide')}
        data-testid={`help-${topic}`}
      >
        <IconHelp size={16} />
      </ActionIcon>
    </Tooltip>
  );
}
