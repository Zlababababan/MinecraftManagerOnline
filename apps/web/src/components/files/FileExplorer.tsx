/**
 * Explorateur de fichiers « mode avancé » (doc 02 §6) : navigation jailée au dossier serveur,
 * création de dossier/fichier, renommage, duplication, corbeille `.mmo-trash/` (jamais de
 * suppression directe), éditeur texte ≤ 512 Ko avec détection d'édition concurrente (sha256).
 * Phase 8 : téléchargement (lien direct servi en flux par le panel via les transferts binaires)
 * et envoi de fichiers (corps binaire brut, progression XHR, reprise panel↔agent transparente).
 */
import {
  ActionIcon,
  Alert,
  Anchor,
  Breadcrumbs,
  Button,
  Group,
  Loader,
  Menu,
  Modal,
  Stack,
  Table,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import {
  IconCopy,
  IconDotsVertical,
  IconDownload,
  IconFile,
  IconFilePlus,
  IconFolder,
  IconFolderPlus,
  IconLink,
  IconPencil,
  IconTrash,
  IconUpload,
} from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';

import type { FsEntryDto, ServerDto } from '@mmo/protocol/client';

import { fileDownloadUrl, uploadFile } from '../../api/phase8.js';
import { useFileMutations, useFileRead, useFiles, useMe } from '../../api/queries.js';
import { useQueryClient } from '@tanstack/react-query';
import { keys } from '../../api/queries.js';
import { ApiRequestError } from '../../api/client.js';
import { useT } from '../../i18n/hooks.js';
import { describeError } from '../../lib/errors.js';
import { formatBytes, formatDateTime, hasRole } from '../../lib/format.js';
import { ErrorAlert } from '../ErrorAlert.js';

const TEXT_EXTENSIONS =
  /\.(txt|properties|json|json5|yml|yaml|toml|cfg|conf|ini|log|md|sh|bat|cmd|ps1|csv|xml|html?|js|mjs|ts|py|snbt|mcmeta|lang|nbt\.txt)$/i;
const ACCEPT_NAME = /^[^\\/:*?"<>|]+$/;

function join(dir: string, name: string): string {
  return dir === '' ? name : `${dir}/${name}`;
}

function isTextFile(entry: FsEntryDto): boolean {
  return entry.kind === 'file' && (TEXT_EXTENSIONS.test(entry.name) || !entry.name.includes('.'));
}

function TextEditor({
  server,
  path,
  onClose,
}: {
  server: ServerDto;
  path: string;
  onClose: () => void;
}) {
  const { t, i18n } = useT();
  const read = useFileRead(server.id, path);
  const { write } = useFileMutations(server.id);
  const [text, setText] = useState<string | undefined>(undefined);
  const [conflict, setConflict] = useState(false);
  useEffect(() => {
    if (read.data !== undefined && text === undefined) setText(read.data.content);
  }, [read.data, text]);
  const dirty = read.data !== undefined && text !== undefined && text !== read.data.content;
  const close = () => {
    if (!dirty) {
      onClose();
      return;
    }
    modals.openConfirmModal({
      title: t('web:files.unsaved'),
      children: <Text size="sm">{t('web:files.discard')}</Text>,
      labels: { confirm: t('web:files.discard'), cancel: t('web:common.cancel') },
      confirmProps: { color: 'red' },
      onConfirm: onClose,
    });
  };
  const save = () => {
    if (read.data === undefined || text === undefined) return;
    write.mutate(
      { path, content: text, expectedSha256: read.data.sha256 },
      {
        onSuccess: () => {
          setConflict(false);
          setText(undefined);
          notifications.show({ color: 'teal', message: t('web:files.saved') });
        },
        onError: (error) => {
          if (error instanceof ApiRequestError && error.code === 'E_CONFLICT') setConflict(true);
          else notifications.show({ color: 'red', message: describeError(i18n, error) });
        },
      },
    );
  };
  return (
    <Modal
      opened
      onClose={close}
      title={
        <Text ff="monospace" size="sm">
          {path}
        </Text>
      }
      size="xl"
      fullScreen={false}
      data-testid="file-editor"
    >
      <Stack gap="sm">
        {read.isPending && <Loader size="sm" />}
        {read.error && <ErrorAlert error={read.error} />}
        {read.data?.truncated && (
          <Alert color="orange" variant="light">
            {t('web:files.tooBig')}
          </Alert>
        )}
        {conflict && (
          <Alert color="red" variant="light" data-testid="file-conflict">
            <Group justify="space-between">
              <Text size="sm">{t('web:files.conflict')}</Text>
              <Button
                size="xs"
                type="button"
                variant="light"
                onClick={() => {
                  setConflict(false);
                  setText(undefined);
                  void read.refetch();
                }}
              >
                {t('web:files.reload')}
              </Button>
            </Group>
          </Alert>
        )}
        {read.data !== undefined && (
          <Textarea
            value={text ?? read.data.content}
            onChange={(e) => {
              setText(e.currentTarget.value);
            }}
            autosize
            minRows={12}
            maxRows={30}
            styles={{ input: { fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 13 } }}
            disabled={read.data.truncated}
            data-testid="file-editor-text"
            spellCheck={false}
          />
        )}
        <Group justify="space-between">
          <Text size="xs" c="dimmed">
            {read.data === undefined ? '' : formatBytes(read.data.size)}
          </Text>
          <Group gap="sm">
            <Button type="button" variant="subtle" onClick={close}>
              {t('web:common.close')}
            </Button>
            <Button
              type="button"
              onClick={save}
              disabled={!dirty || read.data.truncated}
              loading={write.isPending}
              data-testid="file-editor-save"
            >
              {t('web:common.save')}
            </Button>
          </Group>
        </Group>
      </Stack>
    </Modal>
  );
}

function NameDialog({
  title,
  label,
  initial,
  onSubmit,
}: {
  title: string;
  label: string;
  initial: string;
  onSubmit: (name: string) => void;
}) {
  const { t } = useT();
  const [name, setName] = useState(initial);
  const valid = ACCEPT_NAME.test(name.trim()) && name.trim() !== '.' && name.trim() !== '..';
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) onSubmit(name.trim());
      }}
      data-testid="file-name-dialog"
    >
      <Stack gap="sm">
        <Text size="sm" fw={600}>
          {title}
        </Text>
        <TextInput
          label={label}
          value={name}
          onChange={(e) => {
            setName(e.currentTarget.value);
          }}
          autoFocus
          data-testid="file-name-input"
        />
        <Group justify="flex-end">
          <Button type="submit" disabled={!valid} data-testid="file-name-submit">
            {t('web:common.confirm')}
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

export function FileExplorer({ server }: { server: ServerDto }) {
  const { t, i18n } = useT();
  const me = useMe();
  const [dir, setDir] = useState('');
  const [editing, setEditing] = useState<string | undefined>(undefined);
  const listing = useFiles(server.id, dir);
  const fsm = useFileMutations(server.id);
  const qc = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const canEdit =
    me.data !== undefined && hasRole(me.data.user.role, 'operator') && server.reachable;
  const fail = (error: unknown) => {
    notifications.show({ color: 'red', message: describeError(i18n, error) });
  };
  const crumbs = dir === '' ? [] : dir.split('/');

  const askName = (
    title: string,
    label: string,
    initial: string,
    action: (name: string) => void,
  ) => {
    const id = modals.open({
      title,
      children: (
        <NameDialog
          title={title}
          label={label}
          initial={initial}
          onSubmit={(name) => {
            modals.close(id);
            action(name);
          }}
        />
      ),
    });
  };
  const doUpload = async (file: File, overwrite: boolean) => {
    const target = join(dir, file.name);
    const id = notifications.show({
      loading: true,
      autoClose: false,
      withCloseButton: false,
      message: t('web:files.uploading', { name: file.name, pct: 0 }),
    });
    setUploading(true);
    try {
      await uploadFile(server.id, target, file, {
        overwrite,
        onProgress: (sent, total) => {
          notifications.update({
            id,
            loading: true,
            autoClose: false,
            message: t('web:files.uploading', {
              name: file.name,
              pct: Math.round((sent / Math.max(1, total)) * 100),
            }),
          });
        },
      });
      notifications.update({
        id,
        loading: false,
        autoClose: 4000,
        message: t('web:files.uploaded', { name: file.name }),
      });
      void qc.invalidateQueries({ queryKey: keys.filesAll(server.id) });
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === 'E_CONFLICT' && !overwrite) {
        notifications.hide(id);
        modals.openConfirmModal({
          title: t('web:files.upload'),
          children: <Text size="sm">{t('web:files.uploadExists', { name: file.name })}</Text>,
          labels: { confirm: t('web:common.confirm'), cancel: t('web:common.cancel') },
          onConfirm: () => {
            void doUpload(file, true);
          },
        });
        return;
      }
      notifications.update({
        id,
        loading: false,
        autoClose: 6000,
        color: 'red',
        message: describeError(i18n, error),
      });
    } finally {
      setUploading(false);
    }
  };
  const newFolder = () => {
    askName(t('web:files.newFolder'), t('web:files.folderName'), '', (name) => {
      fsm.mkdir.mutate(join(dir, name), { onError: fail });
    });
  };
  const newFile = () => {
    askName(t('web:files.newFile'), t('web:files.fileName'), '', (name) => {
      fsm.write.mutate(
        { path: join(dir, name), content: '' },
        {
          onSuccess: () => {
            setEditing(join(dir, name));
          },
          onError: fail,
        },
      );
    });
  };
  const rename = (entry: FsEntryDto) => {
    askName(t('web:files.rename'), t('web:files.newName'), entry.name, (name) => {
      fsm.rename.mutate({ from: join(dir, entry.name), to: join(dir, name) }, { onError: fail });
    });
  };
  const copy = (entry: FsEntryDto) => {
    const dot = entry.name.lastIndexOf('.');
    const suggested =
      entry.kind === 'file' && dot > 0
        ? `${entry.name.slice(0, dot)}-copy${entry.name.slice(dot)}`
        : `${entry.name}-copy`;
    askName(t('web:files.copy'), t('web:files.newName'), suggested, (name) => {
      fsm.copy.mutate({ from: join(dir, entry.name), to: join(dir, name) }, { onError: fail });
    });
  };
  const remove = (entry: FsEntryDto) => {
    modals.openConfirmModal({
      title: t('web:files.delete'),
      children: <Text size="sm">{t('web:files.confirmDelete', { name: entry.name })}</Text>,
      labels: { confirm: t('web:files.delete'), cancel: t('web:common.cancel') },
      confirmProps: { color: 'red' },
      onConfirm: () => {
        fsm.remove.mutate(join(dir, entry.name), {
          onSuccess: (r) => {
            notifications.show({
              color: 'teal',
              message: t('web:files.deleted', { path: r.trashedAs }),
            });
          },
          onError: fail,
        });
      },
    });
  };
  const open = (entry: FsEntryDto) => {
    if (entry.kind === 'dir') setDir(join(dir, entry.name));
    else if (isTextFile(entry)) setEditing(join(dir, entry.name));
  };

  return (
    <Stack gap="md" data-testid="file-explorer">
      <Alert color="gray" variant="light">
        {t('web:files.advancedHint')}
      </Alert>
      <Group justify="space-between" wrap="wrap">
        <Breadcrumbs data-testid="file-breadcrumbs">
          <Anchor
            size="sm"
            onClick={() => {
              setDir('');
            }}
          >
            {t('web:files.root')}
          </Anchor>
          {crumbs.map((part, i) => (
            <Anchor
              key={`${String(i)}-${part}`}
              size="sm"
              onClick={() => {
                setDir(crumbs.slice(0, i + 1).join('/'));
              }}
            >
              {part}
            </Anchor>
          ))}
        </Breadcrumbs>
        {canEdit && (
          <Group gap="xs">
            <Button
              type="button"
              size="xs"
              variant="light"
              leftSection={<IconFolderPlus size={14} />}
              onClick={newFolder}
              data-testid="file-new-folder"
            >
              {t('web:files.newFolder')}
            </Button>
            <Button
              type="button"
              size="xs"
              variant="light"
              leftSection={<IconFilePlus size={14} />}
              onClick={newFile}
              data-testid="file-new-file"
            >
              {t('web:files.newFile')}
            </Button>
            <Button
              type="button"
              size="xs"
              variant="light"
              leftSection={<IconUpload size={14} />}
              loading={uploading}
              onClick={() => {
                fileInput.current?.click();
              }}
              data-testid="file-upload"
            >
              {t('web:files.upload')}
            </Button>
            <input
              ref={fileInput}
              type="file"
              hidden
              data-testid="file-upload-input"
              onChange={(e) => {
                const file = e.currentTarget.files?.[0];
                e.currentTarget.value = '';
                if (file) void doUpload(file, false);
              }}
            />
          </Group>
        )}
      </Group>
      {listing.isPending && <Loader size="sm" />}
      {listing.error && <ErrorAlert error={listing.error} />}
      {listing.data !== undefined &&
        (listing.data.entries.length === 0 ? (
          <Text size="sm" c="dimmed">
            {t('web:files.empty')}
          </Text>
        ) : (
          <Table striped highlightOnHover withTableBorder>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('web:files.name')}</Table.Th>
                <Table.Th visibleFrom="sm">{t('web:files.size')}</Table.Th>
                <Table.Th visibleFrom="sm">{t('web:files.modified')}</Table.Th>
                <Table.Th w={48} />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {listing.data.entries.map((entry) => (
                <Table.Tr
                  key={entry.name}
                  data-testid={`file-${entry.name}`}
                  data-kind={entry.kind}
                >
                  <Table.Td>
                    <Anchor
                      size="sm"
                      component="button"
                      type="button"
                      onClick={() => {
                        open(entry);
                      }}
                      disabled={entry.kind !== 'dir' && !isTextFile(entry)}
                      {...(entry.kind === 'dir' ? {} : { c: 'inherit' })}
                    >
                      <Group gap={6} wrap="nowrap" component="span">
                        {entry.kind === 'dir' ? (
                          <IconFolder size={16} />
                        ) : entry.kind === 'symlink' ? (
                          <IconLink size={16} />
                        ) : (
                          <IconFile size={16} />
                        )}
                        <span style={{ wordBreak: 'break-all' }}>{entry.name}</span>
                      </Group>
                    </Anchor>
                  </Table.Td>
                  <Table.Td visibleFrom="sm">
                    {entry.kind === 'file' ? formatBytes(entry.size ?? 0) : ''}
                  </Table.Td>
                  <Table.Td visibleFrom="sm">
                    {formatDateTime(entry.modifiedAt, i18n.language)}
                  </Table.Td>
                  {(canEdit || entry.kind === 'file') && (
                    <Table.Td>
                      <Menu position="bottom-end" withinPortal>
                        <Menu.Target>
                          <ActionIcon
                            variant="subtle"
                            aria-label={t('web:common.actions')}
                            data-testid={`file-actions-${entry.name}`}
                          >
                            <IconDotsVertical size={16} />
                          </ActionIcon>
                        </Menu.Target>
                        <Menu.Dropdown>
                          {entry.kind === 'file' && (
                            <Menu.Item
                              component="a"
                              href={fileDownloadUrl(server.id, join(dir, entry.name))}
                              download={entry.name}
                              leftSection={<IconDownload size={14} />}
                              data-testid={`file-download-${entry.name}`}
                            >
                              {t('web:files.download')}
                            </Menu.Item>
                          )}
                          {canEdit && isTextFile(entry) && (
                            <Menu.Item
                              leftSection={<IconPencil size={14} />}
                              onClick={() => {
                                open(entry);
                              }}
                            >
                              {t('web:files.edit')}
                            </Menu.Item>
                          )}
                          {canEdit && (
                            <>
                              <Menu.Item
                                leftSection={<IconPencil size={14} />}
                                onClick={() => {
                                  rename(entry);
                                }}
                              >
                                {t('web:files.rename')}
                              </Menu.Item>
                              <Menu.Item
                                leftSection={<IconCopy size={14} />}
                                onClick={() => {
                                  copy(entry);
                                }}
                              >
                                {t('web:files.copy')}
                              </Menu.Item>
                              <Menu.Divider />
                              <Menu.Item
                                color="red"
                                leftSection={<IconTrash size={14} />}
                                onClick={() => {
                                  remove(entry);
                                }}
                              >
                                {t('web:files.delete')}
                              </Menu.Item>
                            </>
                          )}
                        </Menu.Dropdown>
                      </Menu>
                    </Table.Td>
                  )}
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        ))}
      {editing !== undefined && (
        <TextEditor
          server={server}
          path={editing}
          onClose={() => {
            setEditing(undefined);
          }}
        />
      )}
    </Stack>
  );
}
