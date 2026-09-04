/**
 * Lot 8 — page de statut publique d'un serveur : un lien à donner à des amis, sans compte. La
 * carte tient en trois gestes : ouvrir la page, publier ou non les pseudos, changer de lien.
 * Le lien n'est affiché que lorsque la page est active — un lien mort qu'on colle dans un salon
 * Discord est pire que pas de lien du tout.
 */
import {
  Alert,
  Anchor,
  Button,
  Card,
  Code,
  CopyButton,
  Group,
  Stack,
  Switch,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconCopy, IconRefresh, IconWorldShare } from '@tabler/icons-react';
import { useState } from 'react';

import type { ServerDto } from '@mmo/protocol/client';

import { useRotateStatusPage, useSetStatusPage, useStatusPage } from '../../api/status-page.js';
import { useMe } from '../../api/queries.js';
import { useT } from '../../i18n/hooks.js';
import { describeError } from '../../lib/errors.js';
import { canServer } from '../../lib/permissions.js';
import { HelpLink } from '../HelpLink.js';

export function StatusPageCard({ server }: { server: ServerDto }) {
  const { t, i18n } = useT();
  const me = useMe();
  const canEdit = canServer(me.data, server, 'operator');
  const query = useStatusPage(server.id);
  const set = useSetStatusPage(server.id);
  const rotate = useRotateStatusPage(server.id);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const page = query.data?.statusPage ?? null;
  const enabled = page?.enabled ?? false;
  const onError = (error: unknown) => {
    notifications.show({ color: 'red', message: describeError(i18n, error) });
  };
  // Le panel ne connaît pas toujours son URL publique ; l'origine du navigateur est alors la
  // meilleure approximation — c'est bien par là que l'on regarde la page.
  const link = page === null ? null : (page.url ?? window.location.origin + page.path);

  return (
    <Card withBorder radius="md" padding="md" data-testid="status-page">
      <Stack gap="sm">
        <Group gap="xs">
          <IconWorldShare size={18} />
          <Title order={2} size="h4">
            {t('web:statusPage.title')}
          </Title>
          <HelpLink topic="statusPage" />
        </Group>
        <Text size="sm" c="dimmed">
          {t('web:statusPage.hint')}
        </Text>
        <Switch
          label={t('web:statusPage.enable')}
          checked={enabled}
          disabled={!canEdit || set.isPending}
          data-testid="status-page-enabled"
          onChange={(event) => {
            set.mutate({ enabled: event.currentTarget.checked }, { onError });
          }}
        />
        {enabled && link !== null && (
          <>
            <Group gap="xs" wrap="nowrap">
              <Code data-testid="status-page-link" tabIndex={0}>
                {link}
              </Code>
              <CopyButton value={link}>
                {({ copied, copy }) => (
                  <Tooltip label={copied ? t('web:statusPage.copied') : t('web:statusPage.copy')}>
                    <Button
                      type="button"
                      size="compact-xs"
                      variant="light"
                      leftSection={<IconCopy size={14} />}
                      onClick={copy}
                      data-testid="status-page-copy"
                    >
                      {t('web:statusPage.copy')}
                    </Button>
                  </Tooltip>
                )}
              </CopyButton>
              <Anchor href={link} target="_blank" rel="noreferrer" size="sm">
                {t('web:statusPage.open')}
              </Anchor>
            </Group>
            <Switch
              label={t('web:statusPage.showPlayers')}
              description={t('web:statusPage.showPlayersHint')}
              checked={page?.showPlayers ?? false}
              disabled={!canEdit || set.isPending}
              data-testid="status-page-show-players"
              onChange={(event) => {
                set.mutate({ showPlayers: event.currentTarget.checked }, { onError });
              }}
            />
            <Switch
              label={t('web:statusPage.allowWhitelist')}
              description={t('web:statusPage.allowWhitelistHint')}
              checked={page?.allowWhitelist ?? false}
              disabled={!canEdit || set.isPending}
              data-testid="status-page-allow-whitelist"
              onChange={(event) => {
                set.mutate({ allowWhitelist: event.currentTarget.checked }, { onError });
              }}
            />
            {confirmRotate ? (
              <Alert color="orange" data-testid="status-page-rotate-confirm">
                <Stack gap="xs">
                  <Text size="sm">{t('web:statusPage.rotateConfirm')}</Text>
                  <Group gap="xs">
                    <Button
                      type="button"
                      size="xs"
                      color="orange"
                      loading={rotate.isPending}
                      data-testid="status-page-rotate-yes"
                      onClick={() => {
                        rotate.mutate(undefined, {
                          onSuccess: () => {
                            setConfirmRotate(false);
                          },
                          onError,
                        });
                      }}
                    >
                      {t('web:statusPage.rotate')}
                    </Button>
                    <Button
                      type="button"
                      size="xs"
                      variant="default"
                      onClick={() => {
                        setConfirmRotate(false);
                      }}
                    >
                      {t('web:common.cancel')}
                    </Button>
                  </Group>
                </Stack>
              </Alert>
            ) : (
              <Group>
                <Button
                  type="button"
                  size="xs"
                  variant="default"
                  disabled={!canEdit}
                  leftSection={<IconRefresh size={14} />}
                  data-testid="status-page-rotate"
                  onClick={() => {
                    setConfirmRotate(true);
                  }}
                >
                  {t('web:statusPage.rotate')}
                </Button>
              </Group>
            )}
          </>
        )}
      </Stack>
    </Card>
  );
}
