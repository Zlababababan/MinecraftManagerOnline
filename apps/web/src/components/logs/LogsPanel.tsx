/**
 * Journaux (doc 05 §6 `logs.*`) : liste des fichiers `logs/` et recherche exécutée par l'agent
 * (texte ou regex, casse, restriction à certains fichiers) — les archives ne quittent jamais la
 * machine. Téléchargement des archives : phase 8 (transferts).
 */
import {
  Badge,
  Button,
  Checkbox,
  Code,
  Group,
  Loader,
  MultiSelect,
  Stack,
  Table,
  Text,
  TextInput,
} from '@mantine/core';
import { IconSearch } from '@tabler/icons-react';
import { useState } from 'react';

import type { ServerDto } from '@mmo/protocol/client';

import { useLogFiles, useLogSearch } from '../../api/queries.js';
import { useT } from '../../i18n/hooks.js';
import { formatBytes, formatDateTime } from '../../lib/format.js';
import { ErrorAlert } from '../ErrorAlert.js';

export function LogsPanel({ server }: { server: ServerDto }) {
  const { t, i18n } = useT();
  const files = useLogFiles(server.id);
  const search = useLogSearch(server.id);
  const [query, setQuery] = useState('');
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);

  const submit = () => {
    if (query.trim() === '') return;
    search.mutate({
      query,
      regex,
      caseSensitive,
      ...(selected.length === 0 ? {} : { files: selected }),
      limit: 500,
    });
  };

  return (
    <Stack gap="md" data-testid="logs-panel">
      <Text size="xs" c="dimmed">
        {t('web:logs.hint')}
      </Text>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Stack gap="xs">
          <Group gap="xs" align="flex-end" wrap="wrap">
            <TextInput
              label={t('web:logs.search')}
              placeholder={t('web:logs.query')}
              value={query}
              onChange={(e) => {
                setQuery(e.currentTarget.value);
              }}
              style={{ flex: '1 1 240px' }}
              data-testid="logs-query"
            />
            <MultiSelect
              label={t('web:logs.inFiles')}
              placeholder={selected.length === 0 ? t('web:logs.allFiles') : undefined}
              data={(files.data?.files ?? []).map((f) => f.name)}
              value={selected}
              onChange={setSelected}
              clearable
              searchable
              style={{ flex: '1 1 200px' }}
            />
            <Button
              type="submit"
              leftSection={<IconSearch size={16} />}
              loading={search.isPending}
              disabled={query.trim() === '' || !server.reachable}
              data-testid="logs-submit"
            >
              {t('web:logs.search')}
            </Button>
          </Group>
          <Group gap="md">
            <Checkbox
              label={t('web:logs.regex')}
              checked={regex}
              onChange={(e) => {
                setRegex(e.currentTarget.checked);
              }}
            />
            <Checkbox
              label={t('web:logs.caseSensitive')}
              checked={caseSensitive}
              onChange={(e) => {
                setCaseSensitive(e.currentTarget.checked);
              }}
            />
          </Group>
        </Stack>
      </form>
      {search.error && <ErrorAlert error={search.error} />}
      {search.data !== undefined && (
        <Stack gap="xs" data-testid="logs-results">
          <Group gap="xs">
            <Text size="sm">{t('web:logs.results', { count: search.data.matches.length })}</Text>
            {search.data.truncated && (
              <Badge color="orange" variant="light">
                {t('web:logs.truncated')}
              </Badge>
            )}
          </Group>
          {search.data.matches.length === 0 ? (
            <Text size="sm" c="dimmed">
              {t('web:logs.noResults')}
            </Text>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <Table striped withTableBorder fz="xs">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t('web:logs.file')}</Table.Th>
                    <Table.Th>{t('web:logs.line')}</Table.Th>
                    <Table.Th>{t('web:logs.title')}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {search.data.matches.map((m) => (
                    <Table.Tr key={`${m.file}:${String(m.line)}`}>
                      <Table.Td style={{ whiteSpace: 'nowrap' }}>{m.file}</Table.Td>
                      <Table.Td>{m.line}</Table.Td>
                      <Table.Td>
                        <Code
                          block={false}
                          style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}
                        >
                          {m.text}
                        </Code>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </div>
          )}
        </Stack>
      )}
      <Stack gap="xs">
        <Text fw={600} size="sm">
          {t('web:logs.files')}
        </Text>
        {files.isPending && <Loader size="sm" />}
        {files.error && <ErrorAlert error={files.error} />}
        {files.data !== undefined &&
          (files.data.files.length === 0 ? (
            <Text size="sm" c="dimmed">
              {t('web:logs.noFiles')}
            </Text>
          ) : (
            <Table striped withTableBorder data-testid="logs-files">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('web:files.name')}</Table.Th>
                  <Table.Th>{t('web:files.size')}</Table.Th>
                  <Table.Th visibleFrom="sm">{t('web:files.modified')}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {files.data.files.map((f) => (
                  <Table.Tr key={f.name}>
                    <Table.Td ff="monospace">{f.name}</Table.Td>
                    <Table.Td>{formatBytes(f.sizeBytes)}</Table.Td>
                    <Table.Td visibleFrom="sm">
                      {formatDateTime(f.modifiedAt, i18n.language)}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          ))}
      </Stack>
    </Stack>
  );
}
