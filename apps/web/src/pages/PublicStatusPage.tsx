/**
 * Lot 8 — la page que voit un ami muni du lien. Aucune session, aucune action, aucun lien vers le
 * reste du panel : elle vit en dehors de `appRoute` et ne monte ni le Shell, ni le temps réel.
 * Elle ne charge non plus aucune ressource tierce (pas d'avatar mc-heads) : un visiteur anonyme
 * n'a rien à signaler à personne.
 */
import { Badge, Card, Center, Code, CopyButton, Group, Loader, Stack, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';

import type { PublicStatus } from '@mmo/protocol/client';

import { publicStatusQuery } from '../api/status-page.js';
import { useT } from '../i18n/hooks.js';
import { tDynamic } from '../i18n/index.js';
import { formatDateTime } from '../lib/format.js';

const STATE_COLOR: Record<PublicStatus['state'], string> = {
  online: 'teal',
  starting: 'yellow',
  stopping: 'yellow',
  offline: 'gray',
  unknown: 'gray',
};

export function PublicStatusPage({ token }: { token: string }) {
  const { t, i18n } = useT();
  const query = useQuery(publicStatusQuery(token));
  const status = query.data?.status;

  if (query.isPending) {
    return (
      <Center h="60vh">
        <Loader />
      </Center>
    );
  }

  if (status === undefined) {
    return (
      <Center h="60vh" p="md">
        <Text c="dimmed" data-testid="public-status-missing">
          {t('web:publicStatus.missing')}
        </Text>
      </Center>
    );
  }

  const players = status.players;
  return (
    <Center p="md">
      <Card withBorder radius="md" padding="lg" maw={520} w="100%" data-testid="public-status">
        <Stack gap="sm">
          <Group justify="space-between" align="center" wrap="nowrap">
            <Text fw={600} size="lg" data-testid="public-status-name">
              {status.name}
            </Text>
            <Badge
              color={STATE_COLOR[status.state]}
              variant="light"
              data-testid="public-status-state"
              data-state={status.state}
            >
              {tDynamic(i18n, `web:publicStatus.state.${status.state}`)}
            </Badge>
          </Group>
          {status.motd !== null && (
            <Text size="sm" c="dimmed" data-testid="public-status-motd">
              {status.motd}
            </Text>
          )}
          {status.address !== null && (
            <Stack gap={4}>
              <Text size="xs" c="dimmed">
                {t('web:publicStatus.address')}
              </Text>
              <Group gap="xs" wrap="nowrap">
                <Code data-testid="public-status-address" tabIndex={0}>
                  {status.address}
                </Code>
                <CopyButton value={status.address}>
                  {({ copied, copy }) => (
                    <Text
                      component="button"
                      type="button"
                      size="xs"
                      c="blue"
                      onClick={copy}
                      data-testid="public-status-copy"
                      style={{ background: 'none', border: 0, cursor: 'pointer' }}
                    >
                      {copied ? t('web:statusPage.copied') : t('web:statusPage.copy')}
                    </Text>
                  )}
                </CopyButton>
              </Group>
            </Stack>
          )}
          <Group gap="lg">
            {status.version !== null && (
              <Field label={t('web:publicStatus.version')} testId="public-status-version">
                {status.version}
                {status.loader === null
                  ? ''
                  : ` · ${tDynamic(i18n, `common:loader.${status.loader}`)}`}
              </Field>
            )}
            <Field label={t('web:publicStatus.players')} testId="public-status-players">
              {players.online === null
                ? t('web:publicStatus.unknownPlayers')
                : players.max === null
                  ? String(players.online)
                  : `${String(players.online)} / ${String(players.max)}`}
            </Field>
          </Group>
          {players.named && players.names.length > 0 && (
            <Text size="sm" data-testid="public-status-names">
              {players.names.join(', ')}
            </Text>
          )}
          {status.nextBackupAt !== null && (
            <Text size="xs" c="dimmed" data-testid="public-status-backup">
              {t('web:publicStatus.nextBackup', {
                when: formatDateTime(status.nextBackupAt, i18n.language),
              })}
            </Text>
          )}
          <Text size="xs" c="dimmed" data-testid="public-status-source" data-source={status.source}>
            {t(
              status.source === 'agent'
                ? 'web:publicStatus.sourceAgent'
                : status.source === 'ping'
                  ? 'web:publicStatus.sourcePing'
                  : 'web:publicStatus.sourceNone',
              { when: formatDateTime(status.updatedAt, i18n.language) },
            )}
          </Text>
        </Stack>
      </Card>
    </Center>
  );
}

function Field({
  label,
  testId,
  children,
}: {
  label: string;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <Stack gap={0}>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text size="sm" data-testid={testId}>
        {children}
      </Text>
    </Stack>
  );
}
