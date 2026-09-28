/**
 * Réglages → Services tiers : tout ce à quoi le panel, les agents ou le navigateur parlent en dehors
 * de chez vous, ce que chacun sert, et ce qui reste **à vérifier** avant de s'y fier dans un produit
 * commercialisable (la liste vient de `THIRD_PARTY_SERVICES`, `@mmo/shared`).
 *
 * L'intégration FTB y a son interrupteur : coupée, l'assistant de création ne propose plus de
 * modpacks FTB et le panel ne contacte plus leur API.
 */
import { Badge, Card, Stack, Switch, Table, Text, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';

import { THIRD_PARTY_SERVICES } from '@mmo/shared';

import { useUpdateSettings } from '../../api/phase10.js';
import { useT } from '../../i18n/hooks.js';
import { describeError } from '../../lib/errors.js';

export function ThirdPartyCard({ settings }: { settings: Record<string, string> }) {
  const { t, i18n } = useT();
  const update = useUpdateSettings();
  // Absent tant que jamais modifié : le défaut serveur est « activé ».
  const ftbEnabled = settings['modpacks.ftb.enabled'] !== 'false';
  return (
    <Card withBorder radius="md" padding="md" data-testid="settings-third-party">
      <Stack gap="sm">
        <Title order={2} size="h4">
          {t('web:thirdParty.title')}
        </Title>
        <Text size="xs" c="dimmed">
          {t('web:thirdParty.hint')}
        </Text>
        <Switch
          label={t('web:thirdParty.ftbSwitch')}
          description={t('web:thirdParty.ftbSwitchHint')}
          checked={ftbEnabled}
          disabled={update.isPending}
          data-testid="settings-ftb-enabled"
          onChange={(e) => {
            const next = e.currentTarget.checked;
            update.mutate(
              { 'modpacks.ftb.enabled': next ? 'true' : 'false' },
              {
                onError: (error) => {
                  notifications.show({ color: 'red', message: describeError(i18n, error) });
                },
              },
            );
          }}
        />
        <Table.ScrollContainer minWidth={560} scrollAreaProps={{ viewportProps: { tabIndex: 0 } }}>
          <Table verticalSpacing="xs" fz="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('web:thirdParty.colService')}</Table.Th>
                <Table.Th>{t('web:thirdParty.colUse')}</Table.Th>
                <Table.Th>{t('web:thirdParty.colStatus')}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {THIRD_PARTY_SERVICES.map((s) => (
                <Table.Tr key={s.id} data-testid={`third-party-${s.id}`}>
                  <Table.Td>
                    <Text size="sm" fw={500}>
                      {t(`web:thirdParty.services.${s.id}.name`)}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {s.hosts.join(', ')}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">{t(`web:thirdParty.services.${s.id}.use`)}</Text>
                  </Table.Td>
                  <Table.Td>
                    {s.verified ? (
                      <Badge color="teal" variant="light">
                        {t('web:thirdParty.verified')}
                      </Badge>
                    ) : (
                      <Stack gap={4}>
                        <Badge color="gray" variant="light">
                          {t('web:thirdParty.toVerify')}
                        </Badge>
                        <Text size="xs" c="dimmed">
                          {t(`web:thirdParty.services.${s.id}.check`)}
                        </Text>
                      </Stack>
                    )}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Stack>
    </Card>
  );
}
