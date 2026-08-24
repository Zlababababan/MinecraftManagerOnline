/**
 * Réglages → Journal d'audit (admin) : dernières actions (qui, quoi, sur quoi, quand, d'où),
 * lecture seule. Le détail technique complet reste disponible en dépliant une ligne.
 */
import { Button, Card, Code, Collapse, Group, Stack, Table, Text, Title } from '@mantine/core';
import { IconRefresh } from '@tabler/icons-react';
import { useState } from 'react';

import type { AuditDto } from '@mmo/protocol/client';

import { useAudit } from '../../api/admin.js';
import { useT } from '../../i18n/hooks.js';
import { formatDateTime } from '../../lib/format.js';
import { ErrorAlert } from '../ErrorAlert.js';

function AuditRow({ entry }: { entry: AuditDto }) {
  const { t, i18n } = useT();
  const [open, setOpen] = useState(false);
  const hasDetails = entry.details !== null && entry.details !== undefined;
  return (
    <>
      <Table.Tr
        onClick={() => {
          if (hasDetails) setOpen((v) => !v);
        }}
        style={hasDetails ? { cursor: 'pointer' } : undefined}
        data-testid={`audit-${String(entry.id)}`}
      >
        <Table.Td style={{ whiteSpace: 'nowrap' }}>
          <Text size="xs">{formatDateTime(entry.ts, i18n.language)}</Text>
        </Table.Td>
        <Table.Td>{entry.username ?? t('web:common.unknown')}</Table.Td>
        <Table.Td>
          <Code>{entry.action}</Code>
        </Table.Td>
        <Table.Td>{entry.targetLabel ?? entry.targetId ?? '—'}</Table.Td>
        <Table.Td visibleFrom="sm">
          <Text size="xs" c="dimmed">
            {entry.ip ?? '—'}
          </Text>
        </Table.Td>
      </Table.Tr>
      {hasDetails && open && (
        <Table.Tr>
          <Table.Td colSpan={5} p={0}>
            <Collapse in={open}>
              <Code block m="xs" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                {JSON.stringify(entry.details, null, 2)}
              </Code>
            </Collapse>
          </Table.Td>
        </Table.Tr>
      )}
    </>
  );
}

export function AuditCard() {
  const { t } = useT();
  const audit = useAudit(200);
  return (
    <Card withBorder radius="md" padding="md" data-testid="settings-audit">
      <Stack gap="sm">
        <Group justify="space-between">
          <Title order={4}>{t('web:settings.audit.title')}</Title>
          <Button
            variant="subtle"
            size="compact-xs"
            color="gray"
            leftSection={<IconRefresh size={14} />}
            loading={audit.isFetching}
            onClick={() => {
              void audit.refetch();
            }}
            data-testid="audit-refresh"
          >
            {t('web:common.refresh')}
          </Button>
        </Group>
        <Text size="xs" c="dimmed">
          {t('web:settings.audit.hint')}
        </Text>
        <ErrorAlert error={audit.error} />
        {audit.data !== undefined &&
          (audit.data.audit.length === 0 ? (
            <Text size="sm" c="dimmed">
              {t('web:settings.audit.empty')}
            </Text>
          ) : (
            <Table.ScrollContainer minWidth={640}>
              <Table striped highlightOnHover fz="sm">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t('web:common.date')}</Table.Th>
                    <Table.Th>{t('web:settings.audit.user')}</Table.Th>
                    <Table.Th>{t('web:settings.audit.action')}</Table.Th>
                    <Table.Th>{t('web:settings.audit.target')}</Table.Th>
                    <Table.Th visibleFrom="sm">IP</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {audit.data.audit.map((entry) => (
                    <AuditRow key={entry.id} entry={entry} />
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          ))}
      </Stack>
    </Card>
  );
}
