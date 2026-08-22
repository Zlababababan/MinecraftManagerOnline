/** EULA guidée (doc 06 §7) : explication, lien vers le texte officiel, case à cocher, puis `server.eulaAccept`. */
import { Alert, Anchor, Button, Checkbox, Group, Stack, Text } from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { IconExternalLink, IconFileCertificate } from '@tabler/icons-react';
import { useState } from 'react';

import type { ServerDto } from '@mmo/protocol/client';

import { useAcceptEula } from '../../api/queries.js';
import { useT } from '../../i18n/hooks.js';
import { describeError } from '../../lib/errors.js';

export const EULA_URL = 'https://www.minecraft.net/eula';

function EulaDialog({ onAccept, pending }: { onAccept: () => void; pending: boolean }) {
  const { t } = useT();
  const [checked, setChecked] = useState(false);
  return (
    <Stack gap="md" data-testid="eula-dialog">
      <Text size="sm">{t('web:eula.intro')}</Text>
      <Anchor href={EULA_URL} target="_blank" rel="noopener noreferrer" size="sm">
        <Group gap={4} component="span">
          {t('web:eula.link')} <IconExternalLink size={14} />
        </Group>
      </Anchor>
      <Checkbox
        label={t('web:eula.checkbox')}
        checked={checked}
        onChange={(e) => {
          setChecked(e.currentTarget.checked);
        }}
        data-testid="eula-checkbox"
      />
      <Group justify="flex-end">
        <Button
          type="button"
          disabled={!checked}
          loading={pending}
          onClick={onAccept}
          leftSection={<IconFileCertificate size={16} />}
          data-testid="eula-accept"
        >
          {t('web:eula.accept')}
        </Button>
      </Group>
    </Stack>
  );
}

export function EulaCard({ server, canOperate }: { server: ServerDto; canOperate: boolean }) {
  const { t, i18n } = useT();
  const eula = useAcceptEula(server.id);
  if (server.eulaAccepted) return null;
  const open = () => {
    const id = modals.open({
      title: t('web:eula.title'),
      children: (
        <EulaDialog
          pending={eula.isPending}
          onAccept={() => {
            eula.mutate(undefined, {
              onSuccess: () => {
                modals.close(id);
                notifications.show({ color: 'teal', message: t('web:eula.accepted') });
              },
              onError: (error) => {
                notifications.show({ color: 'red', message: describeError(i18n, error) });
              },
            });
          }}
        />
      ),
    });
  };
  return (
    <Alert color="yellow" variant="light" data-testid="eula-alert" title={t('web:eula.title')}>
      <Group justify="space-between" wrap="wrap">
        <Text size="sm">{t('web:server.eulaHint')}</Text>
        {canOperate && (
          <Button
            size="xs"
            type="button"
            onClick={open}
            disabled={!server.reachable}
            data-testid="eula-open"
          >
            {t('web:server.acceptEula')}
          </Button>
        )}
      </Group>
    </Alert>
  );
}
