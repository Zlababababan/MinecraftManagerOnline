/**
 * Macros de console : les séquences enregistrées, à un clic, au-dessus du champ de saisie.
 *
 * Un clic exécute de VRAIES commandes. Deux garde-fous en découlent :
 *   - une macro qui contient un arrêt, un bannissement ou une destruction demande confirmation,
 *     en montrant la séquence exacte — « arrêter le serveur » ne doit jamais être un clic distrait ;
 *   - le résultat dit quelles commandes sont passées et où ça s'est arrêté, parce que la séquence
 *     s'interrompt au premier échec et que l'état intermédiaire (sauvegarde désactivée, par
 *     exemple) doit se voir.
 */
import {
  ActionIcon,
  Badge,
  Button,
  Code,
  Group,
  Modal,
  Stack,
  Text,
  TextInput,
  Textarea,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconBolt, IconPencil, IconPlus, IconTrash } from '@tabler/icons-react';
import { useState } from 'react';

import type { ApiErrorCode } from '@mmo/protocol/client';

import {
  useCreateMacro,
  useDeleteMacro,
  useMacros,
  useRunMacro,
  useUpdateMacro,
} from '../../api/queries.js';
import { useT } from '../../i18n/hooks.js';
import { ApiRequestError } from '../../api/client.js';
import { describeError } from '../../lib/errors.js';
import { TECHNICAL_INPUT_PROPS } from '../../lib/inputs.js';

interface EditorState {
  id?: string;
  name: string;
  commands: string;
  /** Coché : la macro ne vaut que pour ce serveur. Décoché (défaut) : toute la flotte. */
  thisServerOnly: boolean;
}

const EMPTY: EditorState = { name: '', commands: '', thisServerOnly: false };

export function MacroBar({ serverId, canSend }: { serverId: string; canSend: boolean }) {
  const { t, i18n } = useT();
  const macros = useMacros(serverId, canSend);
  const run = useRunMacro(serverId);
  const create = useCreateMacro();
  const update = useUpdateMacro();
  const remove = useDeleteMacro();
  const [editor, setEditor] = useState<EditorState | undefined>();
  const [confirming, setConfirming] = useState<
    { id: string; name: string; commands: string[] } | undefined
  >();

  if (!canSend) return null;

  const execute = (
    macro: { id: string; name: string; commands: string[] },
    confirmed = false,
  ): void => {
    setConfirming(undefined);
    run.mutate(
      { macroId: macro.id, ...(confirmed ? { confirmDestructive: true } : {}) },
      {
        onSuccess: (data) => {
          const failed = data.results.find((r) => !r.ok);
          notifications.show({
            color: failed ? 'red' : 'teal',
            // La CAUSE de l'échec, pas seulement la commande : sans elle, « échec sur save-off »
            // n'apprend rien, et rien d'autre dans l'interface ne la porte.
            message: failed
              ? t('web:server.macros.partial', {
                  name: macro.name,
                  done: data.results.filter((r) => r.ok).length,
                  total: macro.commands.length,
                  command: failed.command,
                  reason: describeError(
                    i18n,
                    new ApiRequestError(500, {
                      code: (failed.error ?? 'E_INTERNAL') as ApiErrorCode,
                      message: failed.message ?? '',
                      retryable: false,
                    }),
                  ),
                })
              : t('web:server.macros.done', { name: macro.name, count: data.results.length }),
            // Un échec ne doit pas disparaître tout seul : c'est la seule trace lisible.
            ...(failed ? { autoClose: false as const } : {}),
          });
        },
        onError: (error) => {
          // Le panel refuse une macro destructrice sans confirmation explicite : c'est le cas
          // normal d'une liste locale devenue obsolète. On ouvre la confirmation avec la
          // séquence QU'IL vient de renvoyer, pas avec celle qu'on croyait connaître.
          const details =
            error instanceof ApiRequestError && error.code === 'E_CONFLICT'
              ? (error.details as { reason?: string; commands?: string[]; name?: string })
              : undefined;
          if (details?.reason === 'confirm_required') {
            setConfirming({
              id: macro.id,
              name: details.name ?? macro.name,
              commands: details.commands ?? macro.commands,
            });
            return;
          }
          notifications.show({ color: 'red', message: describeError(i18n, error) });
        },
      },
    );
  };

  const submit = (): void => {
    if (!editor) return;
    const body = {
      name: editor.name,
      commands: editor.commands,
      serverId: editor.thisServerOnly ? serverId : null,
    };
    const onDone = {
      onSuccess: () => {
        setEditor(undefined);
      },
      onError: (error: unknown) => {
        notifications.show({ color: 'red', message: describeError(i18n, error) });
      },
    };
    if (editor.id === undefined) create.mutate(body, onDone);
    else update.mutate({ id: editor.id, body }, onDone);
  };

  return (
    <>
      <Group gap={6} data-testid="console-macros">
        {(macros.data?.macros ?? []).map((macro) => (
          <Group key={macro.id} gap={2} wrap="nowrap">
            <Tooltip label={macro.commands.join(' · ')} multiline w={280} openDelay={400}>
              <Button
                size="compact-xs"
                variant="light"
                {...(macro.destructive ? { color: 'orange' } : {})}
                leftSection={<IconBolt size={12} />}
                loading={run.isPending && run.variables.macroId === macro.id}
                onClick={() => {
                  if (macro.destructive) setConfirming(macro);
                  else execute(macro);
                }}
                data-testid={`macro-run-${macro.id}`}
              >
                {macro.name}
              </Button>
            </Tooltip>
            <ActionIcon
              size="xs"
              variant="subtle"
              color="gray"
              aria-label={t('web:common.edit')}
              onClick={() => {
                setEditor({
                  id: macro.id,
                  name: macro.name,
                  commands: macro.commands.join('\n'),
                  thisServerOnly: macro.serverId !== null,
                });
              }}
              data-testid={`macro-edit-${macro.id}`}
            >
              <IconPencil size={12} />
            </ActionIcon>
          </Group>
        ))}
        <Button
          size="compact-xs"
          variant="subtle"
          leftSection={<IconPlus size={12} />}
          onClick={() => {
            setEditor({ ...EMPTY });
          }}
          data-testid="macro-new"
        >
          {t('web:server.macros.add')}
        </Button>
      </Group>

      <Modal
        opened={confirming !== undefined}
        onClose={() => {
          setConfirming(undefined);
        }}
        title={t('web:server.macros.confirmTitle', { name: confirming?.name ?? '' })}
        data-testid="macro-confirm"
      >
        <Stack gap="sm">
          <Text size="sm">{t('web:server.macros.confirmBody')}</Text>
          {/* La séquence exacte, en clair : c'est elle qu'on approuve, pas un nom. */}
          <Stack gap={2}>
            {(confirming?.commands ?? []).map((command, i) => (
              <Code key={`${String(i)}-${command}`}>{command}</Code>
            ))}
          </Stack>
          <Group justify="flex-end">
            <Button
              variant="default"
              size="xs"
              onClick={() => {
                setConfirming(undefined);
              }}
            >
              {t('web:common.cancel')}
            </Button>
            <Button
              color="orange"
              size="xs"
              onClick={() => {
                if (confirming) execute(confirming, true);
              }}
              data-testid="macro-confirm-run"
            >
              {t('web:server.macros.confirmRun')}
            </Button>
          </Group>
        </Stack>
      </Modal>

      <Modal
        opened={editor !== undefined}
        onClose={() => {
          setEditor(undefined);
        }}
        title={
          editor?.id === undefined
            ? t('web:server.macros.newTitle')
            : t('web:server.macros.editTitle')
        }
        data-testid="macro-editor"
      >
        <Stack gap="sm">
          <TextInput
            label={t('web:server.macros.name')}
            value={editor?.name ?? ''}
            onChange={(e) => {
              setEditor((s) => (s ? { ...s, name: e.currentTarget.value } : s));
            }}
            data-testid="macro-name"
          />
          <Textarea
            label={t('web:server.macros.commands')}
            description={t('web:server.macros.commandsHint')}
            autosize
            minRows={3}
            maxRows={12}
            value={editor?.commands ?? ''}
            onChange={(e) => {
              setEditor((s) => (s ? { ...s, commands: e.currentTarget.value } : s));
            }}
            {...TECHNICAL_INPUT_PROPS}
            data-testid="macro-commands"
          />
          <Group gap="xs">
            <Badge
              component="button"
              type="button"
              aria-pressed={editor?.thisServerOnly === true}
              variant={editor?.thisServerOnly === true ? 'filled' : 'light'}
              color="gray"
              style={{ cursor: 'pointer' }}
              onClick={() => {
                setEditor((s) => (s ? { ...s, thisServerOnly: !s.thisServerOnly } : s));
              }}
              data-testid="macro-scope"
            >
              {editor?.thisServerOnly === true
                ? t('web:server.macros.scopeServer')
                : t('web:server.macros.scopeAll')}
            </Badge>
          </Group>
          <Group justify="space-between">
            {editor?.id !== undefined ? (
              <Button
                variant="subtle"
                color="red"
                size="xs"
                leftSection={<IconTrash size={14} />}
                loading={remove.isPending}
                onClick={() => {
                  const id = editor.id;
                  if (id === undefined) return;
                  remove.mutate(id, {
                    onSuccess: () => {
                      setEditor(undefined);
                    },
                    onError: (error) => {
                      notifications.show({ color: 'red', message: describeError(i18n, error) });
                    },
                  });
                }}
                data-testid="macro-delete"
              >
                {t('web:common.delete')}
              </Button>
            ) : (
              <span />
            )}
            <Button
              size="xs"
              onClick={submit}
              loading={create.isPending || update.isPending}
              data-testid="macro-save"
            >
              {t('web:common.save')}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
