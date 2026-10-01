/**
 * « Dans quel dossier de cette machine ranger vos serveurs ? » — le formulaire d'ajout d'un
 * répertoire surveillé, posé LÀ où il manque (après l'appairage, au moment de créer un serveur,
 * au moment d'actualiser la liste) au lieu d'envoyer chercher la page de la machine.
 */
import { Button, Group, Stack, TextInput } from '@mantine/core';
import { useForm } from '@mantine/form';

import { useAddDirectory } from '../../api/queries.js';
import { useT } from '../../i18n/hooks.js';
import { TECHNICAL_INPUT_PROPS } from '../../lib/inputs.js';
import { ErrorAlert } from '../ErrorAlert.js';

export function DirectoryForm({
  machineId,
  testId,
  onAdded,
}: {
  machineId: string;
  testId: string;
  onAdded?: () => void;
}) {
  const { t } = useT();
  const addDir = useAddDirectory(machineId);
  const form = useForm({
    initialValues: { path: '' },
    validate: { path: (v) => (v.trim() === '' ? t('web:errors.validation') : null) },
  });
  return (
    <form
      onSubmit={form.onSubmit((values) => {
        addDir.mutate(
          { path: values.path.trim() },
          {
            onSuccess: () => {
              onAdded?.();
            },
          },
        );
      })}
    >
      <Stack gap="xs">
        <Group align="flex-end" gap="xs" wrap="nowrap">
          <TextInput
            label={t('web:machine.next.directoryAsk')}
            placeholder={t('web:machine.directoryPlaceholder')}
            style={{ flex: 1 }}
            {...TECHNICAL_INPUT_PROPS}
            data-testid={testId}
            {...form.getInputProps('path')}
          />
          <Button type="submit" loading={addDir.isPending} data-testid={`${testId}-add`}>
            {t('web:common.add')}
          </Button>
        </Group>
        <ErrorAlert error={addDir.error} />
      </Stack>
    </form>
  );
}
