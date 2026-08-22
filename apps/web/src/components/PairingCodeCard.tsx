/** Code d'appairage affiché une seule fois + one-liners d'installation (si `panel.publicUrl`). */
import {
  Alert,
  Box,
  Code,
  CopyButton,
  Group,
  Stack,
  Text,
  Title,
  Tooltip,
  ActionIcon,
} from '@mantine/core';
import { IconCheck, IconCopy } from '@tabler/icons-react';
import { useT } from '../i18n/hooks.js';

import type { PairingCodeDto } from '@mmo/protocol/client';

import { formatDateTime } from '../lib/format.js';

function CopyField({ value, label }: { value: string; label: string }) {
  const { t } = useT();
  return (
    <Stack gap={4}>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Group gap="xs" wrap="nowrap" align="flex-start">
        <Code block style={{ flex: 1, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
          {value}
        </Code>
        <CopyButton value={value}>
          {({ copied, copy }) => (
            <Tooltip label={copied ? t('web:common.copied') : t('web:common.copy')} withArrow>
              <ActionIcon
                variant="light"
                color={copied ? 'teal' : 'gray'}
                onClick={copy}
                aria-label={t('web:common.copy')}
              >
                {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
              </ActionIcon>
            </Tooltip>
          )}
        </CopyButton>
      </Group>
    </Stack>
  );
}

export function PairingCodeCard({ pairing }: { pairing: PairingCodeDto }) {
  const { t, i18n } = useT();
  return (
    <Stack gap="md" data-testid="pairing-card">
      <Title order={4}>{t('web:machine.pairing.title')}</Title>
      <Alert color="yellow" variant="light">
        {t('web:machine.pairing.once')}
      </Alert>
      <Box>
        <Text size="xs" c="dimmed">
          {t('web:machine.pairing.code')}
        </Text>
        <Group gap="sm" align="center">
          <Text
            ff="monospace"
            fz={28}
            fw={700}
            style={{ letterSpacing: '0.15em' }}
            data-testid="pairing-code"
          >
            {pairing.code}
          </Text>
          <CopyButton value={pairing.code}>
            {({ copied, copy }) => (
              <Tooltip label={copied ? t('web:common.copied') : t('web:common.copy')} withArrow>
                <ActionIcon
                  variant="light"
                  color={copied ? 'teal' : 'gray'}
                  onClick={copy}
                  aria-label={t('web:common.copy')}
                >
                  {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
                </ActionIcon>
              </Tooltip>
            )}
          </CopyButton>
        </Group>
        <Text size="xs" c="dimmed">
          {t('web:machine.pairing.expires')} : {formatDateTime(pairing.expiresAt, i18n.language)}
        </Text>
      </Box>
      {pairing.install === undefined ? (
        <Alert color="blue" variant="light">
          {t('web:machine.pairing.noPublicUrl')}
        </Alert>
      ) : (
        <Stack gap="sm">
          <Text fw={600} size="sm">
            {t('web:machine.pairing.install')}
          </Text>
          <CopyField value={pairing.install.windows} label={t('web:machine.pairing.windows')} />
          <CopyField value={pairing.install.unix} label={t('web:machine.pairing.unix')} />
        </Stack>
      )}
    </Stack>
  );
}
