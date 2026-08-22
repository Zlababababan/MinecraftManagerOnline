/**
 * Phase 11 — carte « Distribution » (Réglages, admin) : version des archives d'installation servies
 * par le panel, runtime, plateformes disponibles (liens de téléchargement), one-liners génériques,
 * état de publication de la release d'agent, suppression.
 */
import {
  Alert,
  Badge,
  Button,
  Card,
  Code,
  CopyButton,
  Group,
  Stack,
  Table,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconCopy, IconTrash } from '@tabler/icons-react';

import { DIST_PLATFORMS } from '@mmo/protocol/client';

import { useClearDistribution, useDistribution } from '../../api/phase11.js';
import { useT } from '../../i18n/hooks.js';
import { tDynamic } from '../../i18n/index.js';
import { describeError } from '../../lib/errors.js';
import { formatBytes } from '../../lib/format.js';

function OneLiner({ label, value, testId }: { label: string; value: string; testId: string }) {
  const { t } = useT();
  return (
    <Group gap="xs" wrap="nowrap" align="flex-start">
      <Text size="xs" c="dimmed" style={{ minWidth: 70 }}>
        {label}
      </Text>
      <Code block style={{ flex: 1, fontSize: 'var(--mantine-font-size-xs)' }} data-testid={testId}>
        {value}
      </Code>
      <CopyButton value={value}>
        {({ copied, copy }) => (
          <Tooltip label={copied ? t('web:playerAccess.copied') : t('web:playerAccess.copy')}>
            <Button
              type="button"
              size="compact-xs"
              variant="light"
              leftSection={<IconCopy size={14} />}
              onClick={copy}
            >
              {t('web:playerAccess.copy')}
            </Button>
          </Tooltip>
        )}
      </CopyButton>
    </Group>
  );
}

export function DistributionCard() {
  const { t, i18n } = useT();
  const dist = useDistribution();
  const clear = useClearDistribution();
  const d = dist.data;
  return (
    <Card withBorder radius="md" padding="md" data-testid="distribution-card">
      <Stack gap="sm">
        <Group justify="space-between">
          <Title order={4}>{t('web:distribution.title')}</Title>
          {d?.available === true && (
            <Button
              type="button"
              size="compact-xs"
              variant="subtle"
              color="red"
              leftSection={<IconTrash size={14} />}
              loading={clear.isPending}
              onClick={() => {
                if (!window.confirm(t('web:distribution.clearConfirm'))) return;
                clear.mutate(undefined, {
                  onError: (error) => {
                    notifications.show({ color: 'red', message: describeError(i18n, error) });
                  },
                });
              }}
              data-testid="distribution-clear"
            >
              {t('web:distribution.clear')}
            </Button>
          )}
        </Group>
        <Text size="sm" c="dimmed">
          {t('web:distribution.hint')}
        </Text>
        {d !== undefined && !d.available && (
          <Alert color="yellow" data-testid="distribution-empty">
            {t('web:distribution.empty')}
            <Code block mt="xs">
              node tools/release/build.mjs{'\n'}node tools/release/publish.mjs --panel{' '}
              {window.location.origin} --user &lt;admin&gt;
            </Code>
          </Alert>
        )}
        {d?.available === true && (
          <>
            <Group gap="xs">
              <Badge variant="light" data-testid="distribution-version">
                {t('web:distribution.version', { version: d.version ?? '?' })}
              </Badge>
              <Badge variant="outline" color="gray">
                Node {d.runtimeVersion}
              </Badge>
              <Badge
                variant="outline"
                color={d.releasePublished ? 'teal' : 'yellow'}
                data-testid="distribution-release"
              >
                {d.releasePublished
                  ? t('web:distribution.releasePublished')
                  : t('web:distribution.releaseMissing')}
              </Badge>
              {d.signingKey === 'dev' && (
                <Badge variant="filled" color="orange" data-testid="distribution-dev-key">
                  {t('web:distribution.devKey')}
                </Badge>
              )}
            </Group>
            <Table withTableBorder withColumnBorders fz="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('web:distribution.platform')}</Table.Th>
                  <Table.Th>{t('web:distribution.file')}</Table.Th>
                  <Table.Th>{t('web:distribution.size')}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {DIST_PLATFORMS.map((p) => {
                  const a = d.platforms[p];
                  return (
                    <Table.Tr
                      key={p}
                      data-testid={`dist-platform-${p}`}
                      data-available={a !== undefined}
                    >
                      <Table.Td>
                        {tDynamic(i18n, `web:distribution.platforms.${p.replace('-', '_')}`)}
                      </Table.Td>
                      <Table.Td>
                        {a === undefined ? (
                          <Text c="dimmed" size="sm">
                            {t('web:distribution.missing')}
                          </Text>
                        ) : (
                          <a href={a.url} download>
                            {a.file}
                          </a>
                        )}
                      </Table.Td>
                      <Table.Td>{a === undefined ? '—' : formatBytes(a.size)}</Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
            {d.install === null ? (
              <Text size="xs" c="dimmed">
                {t('web:distribution.needPublicUrl')}
              </Text>
            ) : (
              <Stack gap="xs">
                <Text size="xs" c="dimmed">
                  {t('web:distribution.oneLinersHint')}
                </Text>
                <OneLiner
                  label="Windows"
                  value={d.install.windows}
                  testId="dist-oneliner-windows"
                />
                <OneLiner
                  label="Linux / macOS"
                  value={d.install.unix}
                  testId="dist-oneliner-unix"
                />
              </Stack>
            )}
          </>
        )}
      </Stack>
    </Card>
  );
}
