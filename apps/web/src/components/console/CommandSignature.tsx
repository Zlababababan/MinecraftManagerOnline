/**
 * L'aperçu demandé : sous le champ de la console, la forme attendue de la commande en cours.
 *
 * Le texte affiché vient d'un serveur moddé arbitraire — donc rendu en texte pur (React échappe),
 * jamais interprété, et coupé : une ligne d'usage de plusieurs kilo-octets existe en vrai.
 *
 * L'aperçu n'exécute jamais rien : il ne fait que décrire ce que le champ attend.
 */
import { Badge, Code, Group, Stack, Text, Tooltip } from '@mantine/core';

import { useT } from '../../i18n/hooks.js';
import { tDynamic } from '../../i18n/index.js';
import type { SignatureView } from './commands.js';

/** Au-delà, la ligne est coupée : un usage de mod peut être immense. */
const MAX_USAGE_LENGTH = 160;

function shorten(text: string): string {
  return text.length > MAX_USAGE_LENGTH ? `${text.slice(0, MAX_USAGE_LENGTH)}…` : text;
}

export function CommandSignature({
  view,
  source,
}: {
  view: SignatureView | undefined;
  /** D'où vient le modèle : le serveur lui-même, ou la table de repli du panel. */
  source: 'discovered' | 'static' | 'unavailable';
}) {
  const { t, i18n } = useT();
  if (!view) return null;
  return (
    <Stack gap={2} data-testid="console-signature">
      <Group gap={6} wrap="nowrap" align="baseline">
        <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
          {view.name}
        </Text>
        <Stack gap={0} style={{ minWidth: 0 }}>
          {view.usages.map((usage) => (
            <Code key={usage} style={{ fontSize: 11, background: 'transparent', padding: 0 }}>
              {shorten(usage)}
            </Code>
          ))}
        </Stack>
        {view.more > 0 && (
          <Text size="xs" c="dimmed">
            {t('web:server.console.moreUsages', { count: view.more })}
          </Text>
        )}
        {source !== 'discovered' && (
          // Sans cette mention, un utilisateur sur modpack croirait l'aperçu exhaustif et
          // conclurait qu'une commande de mod n'existe pas. Deux explications distinctes :
          // « static » = serveur arrêté (le démarrer changera les choses) ; « unavailable » =
          // il tourne mais n'a pas répondu — lui conseiller de le démarrer serait mentir.
          <Tooltip
            label={t(
              source === 'unavailable'
                ? 'web:server.console.sourceUnavailableHint'
                : 'web:server.console.sourceStaticHint',
            )}
            multiline
            w={260}
          >
            <Badge
              size="xs"
              variant="light"
              color="gray"
              data-testid="console-signature-source"
              data-source={source}
            >
              {t(
                source === 'unavailable'
                  ? 'web:server.console.sourceUnavailable'
                  : 'web:server.console.sourceStatic',
              )}
            </Badge>
          </Tooltip>
        )}
      </Group>
      {view.expects !== undefined && (
        <Text size="xs" c="dimmed">
          {tDynamic(i18n, `web:server.console.args.${view.expects}`)}
        </Text>
      )}
      {view.partial && (
        <Text size="xs" c="dimmed">
          {t('web:server.console.usagePartial')}
        </Text>
      )}
    </Stack>
  );
}
