/**
 * « La commande ci-dessus utilise l'adresse enregistrée ; vous, vous êtes passé par une autre. »
 * Le panel propose alors AUSSI la commande qui passe par l'adresse consultée (retour de Yassin,
 * 02/10 : Tailscale coupé, seule l'adresse `…ts.net` était proposée). Voir `installChoices`.
 */
import { Alert, Button, Code, CopyButton, Group, Stack, Text } from '@mantine/core';
import { IconCopy } from '@tabler/icons-react';

import { useT } from '../i18n/hooks.js';

export interface InstallHere {
  url: string;
  windows: string;
  unix: string;
}

const LOOPBACK = /^https?:\/\/(127\.\d+\.\d+\.\d+|localhost|\[::1\])(:\d+)?$/i;

function Line({ label, value, testId }: { label: string; value: string; testId: string }) {
  const { t } = useT();
  return (
    <Group gap="xs" wrap="nowrap" align="flex-start">
      <Text size="xs" c="dimmed" style={{ minWidth: 90 }}>
        {label}
      </Text>
      <Code
        block
        style={{ flex: 1, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}
        data-testid={testId}
      >
        {value}
      </Code>
      <CopyButton value={value}>
        {({ copied, copy }) => (
          <Button
            type="button"
            size="compact-xs"
            variant="light"
            leftSection={<IconCopy size={14} />}
            onClick={copy}
          >
            {copied ? t('web:common.copied') : t('web:common.copy')}
          </Button>
        )}
      </CopyButton>
    </Group>
  );
}

export function InstallHereNotice({ here }: { here: InstallHere | undefined }) {
  const { t } = useT();
  if (here === undefined) return null;
  return (
    <Alert color="yellow" variant="light" data-testid="install-here">
      <Stack gap="xs">
        <Text size="sm">{t('web:installHere.why', { url: here.url })}</Text>
        {LOOPBACK.test(here.url) && (
          <Text size="xs" c="dimmed" data-testid="install-here-loopback">
            {t('web:installHere.loopback')}
          </Text>
        )}
        <Line label="Windows" value={here.windows} testId="install-here-windows" />
        <Line label="Linux / macOS" value={here.unix} testId="install-here-unix" />
      </Stack>
    </Alert>
  );
}
