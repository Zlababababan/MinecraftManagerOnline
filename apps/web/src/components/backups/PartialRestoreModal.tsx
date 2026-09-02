/**
 * Lot 4 — restauration partielle : arbre à cases du contenu d'une archive (lu par l'agent sans
 * extraction), sélection par dossier ou fichier, deux modes — côte à côte par défaut (extraction
 * dans `restored-<date>/`, rien n'est remplacé, le serveur tourne) ou en place (chemins remplacés,
 * serveur arrêté, sauvegarde de sécurité). Un agent N-1 répond `E_UNSUPPORTED_TYPE` : dit tel quel.
 *
 * La sélection n'est pas celle du composant `Tree` (ses cases cochées sont des feuilles ; un dossier
 * non déplié n'aurait rien à cocher) : un ensemble de chemins, où un dossier coché vaut tout son
 * contenu — exactement ce que l'agent reçoit (`paths`, prédicat d'inclusion par préfixe).
 */
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Group,
  Loader,
  Modal,
  Radio,
  Stack,
  Text,
  TextInput,
  Tree,
  useTree,
  type RenderTreeNodePayload,
  type TreeNodeData,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconChevronDown, IconChevronRight, IconFile, IconFolder } from '@tabler/icons-react';
import { useMemo, useState } from 'react';

import type { BackupBrowseEntry, BackupDto, RestoreMode, ServerDto } from '@mmo/protocol/client';

import { ApiRequestError } from '../../api/client.js';
import { useBackupBrowse, useRestorePaths } from '../../api/phase8.js';
import { useT } from '../../i18n/hooks.js';
import { describeError } from '../../lib/errors.js';
import { formatBytes, formatDateTime } from '../../lib/format.js';
import { ErrorAlert } from '../ErrorAlert.js';

// --- Sélection (fonctions pures) ------------------------------------------------------------------

export type SelectionState = 'checked' | 'inherited' | 'partial' | 'none';

/** `inherited` : un ancêtre est coché (case cochée, grisée) ; `partial` : un descendant l'est. */
export function selectionStateOf(path: string, selected: ReadonlySet<string>): SelectionState {
  if (selected.has(path)) return 'checked';
  for (const p of selected) if (path.startsWith(`${p}/`)) return 'inherited';
  for (const p of selected) if (p.startsWith(`${path}/`)) return 'partial';
  return 'none';
}

/** Coche ou décoche ; cocher un dossier retire ses descendants déjà cochés (redondants). */
export function toggleSelection(path: string, selected: ReadonlySet<string>): Set<string> {
  const next = new Set(selected);
  if (next.has(path)) {
    next.delete(path);
    return next;
  }
  if (selectionStateOf(path, selected) === 'inherited') return next;
  for (const p of next) if (p.startsWith(`${path}/`)) next.delete(p);
  next.add(path);
  return next;
}

function parentOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

/**
 * Arbre `Tree` à partir des entrées plates : dossiers d'abord puis fichiers, ordre alphabétique.
 * Avec un filtre, seules les entrées dont le chemin contient le texte restent — et leurs ancêtres.
 */
export function buildTree(entries: readonly BackupBrowseEntry[], filter = ''): TreeNodeData[] {
  const q = filter.trim().toLowerCase();
  const keep = new Set<string>();
  if (q !== '') {
    for (const e of entries) {
      if (!e.path.toLowerCase().includes(q)) continue;
      for (let p = e.path; p !== ''; p = parentOf(p)) keep.add(p);
    }
  }
  const children = new Map<string, BackupBrowseEntry[]>();
  for (const e of entries) {
    if (q !== '' && !keep.has(e.path)) continue;
    const parent = parentOf(e.path);
    const list = children.get(parent) ?? [];
    list.push(e);
    children.set(parent, list);
  }
  const ordered = (list: BackupBrowseEntry[]): BackupBrowseEntry[] =>
    list.sort((a, b) =>
      a.kind !== b.kind
        ? a.kind === 'dir'
          ? -1
          : 1
        : a.path < b.path
          ? -1
          : a.path > b.path
            ? 1
            : 0,
    );
  const build = (parent: string): TreeNodeData[] =>
    ordered(children.get(parent) ?? []).map((e) => ({
      value: e.path,
      label: e.path.slice(e.path.lastIndexOf('/') + 1),
      ...(e.kind === 'dir' ? { children: build(e.path) } : {}),
    }));
  return build('');
}

/** Ce que la sélection représente (un dossier compte pour tout ce qu'il contient). */
export function summarizeSelection(
  selected: ReadonlySet<string>,
  entries: readonly BackupBrowseEntry[],
): { paths: number; files: number; bytes: number } {
  const byPath = new Map(entries.map((e) => [e.path, e]));
  let files = 0;
  let bytes = 0;
  for (const p of selected) {
    const e = byPath.get(p);
    if (e === undefined) continue;
    bytes += e.size;
    files += e.kind === 'dir' ? (e.files ?? 0) : 1;
  }
  return { paths: selected.size, files, bytes };
}

// --- Composant -------------------------------------------------------------------------------------

export function PartialRestoreModal({
  server,
  backup,
  onClose,
}: {
  server: ServerDto;
  backup: BackupDto;
  onClose: () => void;
}) {
  const { t, i18n } = useT();
  const q = useBackupBrowse(server.id, backup.id);
  const restore = useRestorePaths(server.id);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [mode, setMode] = useState<RestoreMode>('side_by_side');
  const [safetyBackup, setSafetyBackup] = useState(true);
  const [restartAfter, setRestartAfter] = useState(server.runState === 'running');
  const tree = useTree();
  const entries = useMemo(() => q.data?.entries ?? [], [q.data]);
  const data = useMemo(() => buildTree(entries, filter), [entries, filter]);
  const byPath = useMemo(() => new Map(entries.map((e) => [e.path, e])), [entries]);
  const summary = summarizeSelection(selected, entries);
  const unsupported = q.error instanceof ApiRequestError && q.error.code === 'E_UNSUPPORTED_TYPE';
  const inPlace = mode === 'in_place';

  const submit = () => {
    restore.mutate(
      {
        backupId: backup.id,
        paths: [...selected].sort(),
        mode,
        safetyBackup: inPlace && safetyBackup,
        restartAfter: inPlace && restartAfter,
      },
      {
        onError: (error) => {
          notifications.show({ color: 'red', message: describeError(i18n, error) });
        },
        onSuccess: () => {
          notifications.show({ message: t('web:backups.partial.started') });
          onClose();
        },
      },
    );
  };

  const renderNode = ({ node, expanded, hasChildren, elementProps }: RenderTreeNodePayload) => {
    const entry = byPath.get(node.value);
    const state = selectionStateOf(node.value, selected);
    return (
      <Group gap={6} wrap="nowrap" py={2} {...elementProps}>
        <Checkbox
          size="xs"
          checked={state === 'checked' || state === 'inherited'}
          indeterminate={state === 'partial'}
          disabled={state === 'inherited'}
          aria-label={node.value}
          onClick={(e) => {
            e.stopPropagation();
          }}
          onChange={() => {
            setSelected((s) => toggleSelection(node.value, s));
          }}
          data-testid={`restore-path-${node.value}`}
        />
        {hasChildren ? (
          expanded ? (
            <IconChevronDown size={14} />
          ) : (
            <IconChevronRight size={14} />
          )
        ) : (
          <span style={{ width: 14 }} />
        )}
        {entry?.kind === 'dir' ? <IconFolder size={16} /> : <IconFile size={16} />}
        <Text size="sm" truncate {...(entry?.kind === 'file' ? { ff: 'monospace' } : {})}>
          {node.label}
        </Text>
        {entry !== undefined && (
          <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
            {entry.kind === 'dir'
              ? `${formatBytes(entry.size)} · ${t('web:backups.files', { count: entry.files ?? 0 })}`
              : formatBytes(entry.size)}
          </Text>
        )}
        {entry?.truncated === true && (
          <Badge size="xs" color="yellow">
            {t('web:backups.partial.dirTruncated')}
          </Badge>
        )}
      </Group>
    );
  };

  return (
    <Modal
      opened
      onClose={onClose}
      title={t('web:backups.partial.title', {
        date: formatDateTime(backup.finishedAt ?? backup.startedAt, i18n.language),
      })}
      size="lg"
      data-testid="partial-restore"
    >
      <Stack gap="sm">
        <Text size="sm" c="dimmed">
          {t('web:backups.partial.hint')}
        </Text>
        {q.isPending && (
          <Group gap="xs">
            <Loader size="sm" />
            <Text size="sm">{t('web:backups.partial.loading')}</Text>
          </Group>
        )}
        {q.error !== null && !unsupported && <ErrorAlert error={q.error} />}
        {unsupported && (
          <Alert color="orange" variant="light" data-testid="partial-restore-unsupported">
            {t('web:backups.partial.needsNewerAgent')}
          </Alert>
        )}
        {q.data !== undefined && (
          <>
            {q.data.truncated && (
              <Alert color="yellow" variant="light" data-testid="partial-restore-truncated">
                {t('web:backups.partial.truncated', {
                  listed: entries.filter((e) => e.kind === 'file').length,
                  total: q.data.totalFiles,
                })}
              </Alert>
            )}
            <TextInput
              size="xs"
              placeholder={t('web:backups.partial.filter')}
              aria-label={t('web:backups.partial.filter')}
              value={filter}
              onChange={(e) => {
                setFilter(e.currentTarget.value);
              }}
              data-testid="partial-restore-filter"
            />
            <div
              style={{ maxHeight: 360, overflow: 'auto' }}
              tabIndex={0}
              data-testid="partial-restore-tree"
            >
              <Tree data={data} tree={tree} levelOffset={20} renderNode={renderNode} />
            </div>
            <Text size="sm" data-testid="partial-restore-summary">
              {selected.size === 0
                ? t('web:backups.partial.none')
                : t('web:backups.partial.selected', {
                    paths: summary.paths,
                    files: summary.files,
                    size: formatBytes(summary.bytes),
                  })}
            </Text>
            <Radio.Group
              value={mode}
              onChange={(v) => {
                setMode(v === 'in_place' ? 'in_place' : 'side_by_side');
              }}
              label={t('web:backups.partial.mode')}
            >
              <Stack gap="xs" mt={4}>
                <Radio
                  value="side_by_side"
                  label={t('web:backups.partial.sideBySide')}
                  description={t('web:backups.partial.sideBySideHint')}
                  data-testid="partial-restore-side"
                />
                <Radio
                  value="in_place"
                  label={t('web:backups.partial.inPlace')}
                  description={t('web:backups.partial.inPlaceHint')}
                  data-testid="partial-restore-inplace"
                />
              </Stack>
            </Radio.Group>
            {inPlace && (
              <Stack gap="xs" pl="md">
                {server.runState === 'running' && (
                  <Text size="sm" className="mmo-warn-text">
                    {t('web:backups.restoreStops')}
                  </Text>
                )}
                <Checkbox
                  checked={safetyBackup}
                  label={t('web:backups.safetyBackup')}
                  description={t('web:backups.safetyBackupHint')}
                  onChange={(e) => {
                    setSafetyBackup(e.currentTarget.checked);
                  }}
                  data-testid="partial-restore-safety"
                />
                <Checkbox
                  checked={restartAfter}
                  label={t('web:backups.restartAfter')}
                  onChange={(e) => {
                    setRestartAfter(e.currentTarget.checked);
                  }}
                  data-testid="partial-restore-restart"
                />
              </Stack>
            )}
          </>
        )}
        <Group justify="flex-end">
          <Button type="button" variant="default" onClick={onClose}>
            {t('web:common.cancel')}
          </Button>
          <Button
            type="button"
            {...(inPlace ? { color: 'orange' } : {})}
            disabled={selected.size === 0 || restore.isPending || q.data === undefined}
            onClick={submit}
            data-testid="partial-restore-confirm"
          >
            {t('web:backups.partial.confirm')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
