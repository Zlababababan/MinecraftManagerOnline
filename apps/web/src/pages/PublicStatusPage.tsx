/**
 * Lot 8 — la page que voit un ami muni du lien. Aucune session, aucune action, aucun lien vers le
 * reste du panel : elle vit en dehors de `appRoute` et ne monte ni le Shell, ni le temps réel.
 * Elle ne charge non plus aucune ressource tierce (pas d'avatar mc-heads) : un visiteur anonyme
 * n'a rien à signaler à personne.
 */
import {
  Alert,
  Badge,
  Button,
  Card,
  Center,
  Code,
  CopyButton,
  Group,
  Loader,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type SyntheticEvent } from 'react';

import { MAX_WHITELIST_NOTE, MINECRAFT_NAME_RE, type PublicStatus } from '@mmo/protocol/client';

import { publicStatusQuery } from '../api/status-page.js';
import { submitWhitelistRequest } from '../api/whitelist-requests.js';
import { TECHNICAL_INPUT_PROPS } from '../lib/inputs.js';
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
          {status.whitelist && <WhitelistRequestForm token={token} />}
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

/**
 * Demande de whitelist. Le pseudo est validé ICI avec le motif du protocole : un aller-retour
 * pour dire « il manque une lettre » serait une réponse d'API à une faute de frappe. Le panel le
 * revalide de son côté — c'est lui qui compte.
 *
 * Aucun avatar : la page ne charge aucune ressource tierce, et un visiteur anonyme n'a pas à
 * signaler son passage à un service de têtes de joueurs pour taper son pseudo.
 */
function WhitelistRequestForm({ token }: { token: string }) {
  const { t } = useT();
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [touched, setTouched] = useState(false);
  const submit = useMutation({
    mutationFn: (body: { name: string; note?: string }) => submitWhitelistRequest(token, body),
  });
  const valid = MINECRAFT_NAME_RE.test(name.trim());
  const state = submit.data?.state;

  const send = (event: SyntheticEvent) => {
    event.preventDefault();
    setTouched(true);
    if (!valid) return;
    const trimmed = note.trim();
    submit.mutate({ name: name.trim(), ...(trimmed === '' ? {} : { note: trimmed }) });
  };

  return (
    <Card withBorder radius="sm" padding="sm" data-testid="public-whitelist">
      <form onSubmit={send}>
        <Stack gap="xs">
          <Text fw={600} size="sm">
            {t('web:publicStatus.whitelist.title')}
          </Text>
          <Text size="xs" c="dimmed">
            {t('web:publicStatus.whitelist.hint')}
          </Text>
          <TextInput
            label={t('web:publicStatus.whitelist.name')}
            value={name}
            onChange={(event) => {
              setName(event.currentTarget.value);
            }}
            maxLength={16}
            {...TECHNICAL_INPUT_PROPS}
            error={touched && !valid ? t('web:publicStatus.whitelist.invalid') : null}
            data-testid="public-whitelist-name"
          />
          <TextInput
            label={t('web:publicStatus.whitelist.note')}
            value={note}
            onChange={(event) => {
              setNote(event.currentTarget.value);
            }}
            maxLength={MAX_WHITELIST_NOTE}
            data-testid="public-whitelist-note"
          />
          <Group>
            <Button
              type="submit"
              size="xs"
              loading={submit.isPending}
              data-testid="public-whitelist-submit"
            >
              {t('web:publicStatus.whitelist.submit')}
            </Button>
          </Group>
          {state !== undefined && (
            <Alert
              color={state === 'accepted' ? 'teal' : state === 'rejected' ? 'orange' : 'blue'}
              data-testid="public-whitelist-result"
              data-state={state}
            >
              {t(`web:publicStatus.whitelist.${state}`)}
            </Alert>
          )}
          {submit.isError && (
            <Alert color="red" data-testid="public-whitelist-error">
              {t('web:publicStatus.whitelist.failed')}
            </Alert>
          )}
        </Stack>
      </form>
    </Card>
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
