/**
 * Phase 10 — page machine : adresses remontées par l'agent (tailnet / globales) et surcharges manuelles
 * (nom MagicDNS, domaine ou IPv6 publique) utilisées pour « l'adresse à donner aux amis ».
 */
import { Button, Card, Group, SimpleGrid, Stack, Text, TextInput, Title } from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';

import type { MachineDto } from '@mmo/protocol/client';

import { useMe, useUpdateMachine } from '../../api/queries.js';
import { useT } from '../../i18n/hooks.js';
import { describeError } from '../../lib/errors.js';
import { hasRole } from '../../lib/format.js';

export function MachineHostsCard({ machine }: { machine: MachineDto }) {
  const { t, i18n } = useT();
  const me = useMe();
  const isAdmin = me.data !== undefined && hasRole(me.data.user.role, 'admin');
  const update = useUpdateMachine(machine.id);
  const form = useForm({
    initialValues: { tailnetHost: machine.tailnetHost ?? '', publicHost: machine.publicHost ?? '' },
  });
  const detectedTailnet = machine.addresses?.tailnet ?? [];
  const detectedGlobal = machine.addresses?.global ?? [];

  return (
    <Card withBorder radius="md" padding="md" data-testid="machine-hosts">
      <form
        onSubmit={form.onSubmit((values) => {
          update.mutate(
            {
              tailnetHost: values.tailnetHost.trim() === '' ? null : values.tailnetHost.trim(),
              publicHost: values.publicHost.trim() === '' ? null : values.publicHost.trim(),
            },
            {
              onSuccess: () => {
                notifications.show({ color: 'teal', message: t('web:settings.saved') });
              },
              onError: (error) => {
                notifications.show({ color: 'red', message: describeError(i18n, error) });
              },
            },
          );
        })}
      >
        <Stack gap="sm">
          <Title order={2} size="h4">
            {t('web:playerAccess.hosts')}
          </Title>
          <Text size="sm" c="dimmed">
            {t('web:playerAccess.hostsHint')}
          </Text>
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
            <TextInput
              label={t('web:playerAccess.tailnetHost')}
              description={
                detectedTailnet.length > 0
                  ? t('web:playerAccess.detected', { list: detectedTailnet.join(', ') })
                  : undefined
              }
              disabled={!isAdmin}
              {...form.getInputProps('tailnetHost')}
              data-testid="machine-tailnet-host"
            />
            <TextInput
              label={t('web:playerAccess.publicHost')}
              description={
                detectedGlobal.length > 0
                  ? t('web:playerAccess.detected', { list: detectedGlobal.join(', ') })
                  : undefined
              }
              disabled={!isAdmin}
              {...form.getInputProps('publicHost')}
              data-testid="machine-public-host"
            />
          </SimpleGrid>
          {isAdmin && (
            <Group justify="flex-end">
              <Button
                type="submit"
                size="xs"
                loading={update.isPending}
                data-testid="machine-hosts-save"
              >
                {t('web:common.save')}
              </Button>
            </Group>
          )}
        </Stack>
      </form>
    </Card>
  );
}
