/**
 * Phase 10 — page Réglages (admin) : général (`app_settings` via `PATCH /api/settings`), couche
 * d'accès (`AccessCard`), distribution des archives d'installation (`DistributionCard`, phase 11)
 * état du push côté panel (clés VAPID) et sauvegardes du panel lui-même (`PanelBackupsCard`, phase 12).
 */
import {
  Alert,
  Button,
  Card,
  Code,
  Group,
  NumberInput,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';

import { describeTimeZone, localTimeZone } from '@mmo/shared';

import { usePushStatus, useSettings, useUpdateSettings } from '../api/phase10.js';
import { AccessCard } from '../components/admin/AccessCard.js';
import { ApiKeysCard } from '../components/admin/ApiKeysCard.js';
import { AuditCard } from '../components/admin/AuditCard.js';
import { DistributionCard } from '../components/admin/DistributionCard.js';
import { PanelBackupsCard } from '../components/admin/PanelBackupsCard.js';
import { UsersCard } from '../components/admin/UsersCard.js';
import { WebhooksCard } from '../components/admin/WebhooksCard.js';
import { HelpLink } from '../components/HelpLink.js';
import { useT } from '../i18n/hooks.js';
import { describeError } from '../lib/errors.js';
import { coerceOriginInput, isValidOriginInput } from '../lib/origin.js';

/**
 * Fuseaux proposés : ceux que connaît le navigateur. La liste est longue (~400) mais le champ est
 * cherchable, et proposer autre chose que la base IANA du moteur reviendrait à offrir des noms que
 * le panel pourrait refuser.
 */
const TIME_ZONES: string[] = (() => {
  const supported = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
  const list = supported === undefined ? [] : supported('timeZone');
  // Le fuseau du navigateur figure toujours dans la liste, même sur un moteur avare.
  return list.includes(localTimeZone()) ? list : [localTimeZone(), ...list];
})();

function GeneralCard({ settings }: { settings: Record<string, string> }) {
  const { t, i18n } = useT();
  const update = useUpdateSettings();
  const form = useForm({
    initialValues: {
      publicUrl: settings['panel.publicUrl'] ?? '',
      backupDestination: settings['backups.defaultDestination'] ?? '',
      eventsRetention: Number(settings['retention.eventsDays'] ?? '90'),
      auditRetention: Number(settings['retention.auditDays'] ?? '365'),
      commandHistoryRetention: Number(settings['retention.commandHistoryDays'] ?? '90'),
      playerSessionsRetention: Number(settings['retention.playerSessionsDays'] ?? '365'),
      uiEventsRetention: Number(settings['retention.uiEventsDays'] ?? '14'),
      migrationsRetention: Number(settings['retention.migrationsDays'] ?? '90'),
      deletedBackupsRetention: Number(settings['retention.deletedBackupsDays'] ?? '30'),
      tasksRetention: Number(settings['retention.tasksDays'] ?? '30'),
      metricsInterval: Number(settings['metrics.intervalSec'] ?? '15'),
      scheduleTimezone: settings['schedule.timezone'] ?? localTimeZone(),
      restoreOnBoot: settings['agents.restoreOnBoot'] === 'true',
      autoUpdate: settings['agents.autoUpdate'] === 'true' || settings['agents.autoUpdate'] === '1',
      // Absent tant que jamais modifié : le défaut serveur est « activé ».
      updateCheck: settings['panel.updateCheck.enabled'] !== 'false',
    },
    validate: {
      publicUrl: (v) => (isValidOriginInput(v) ? null : t('web:errors.origin')),
    },
  });
  return (
    <Card withBorder radius="md" padding="md" data-testid="settings-general">
      <form
        onSubmit={form.onSubmit((v) => {
          update.mutate(
            {
              'panel.publicUrl': coerceOriginInput(v.publicUrl),
              'backups.defaultDestination': v.backupDestination.trim(),
              'retention.eventsDays': String(v.eventsRetention),
              'retention.auditDays': String(v.auditRetention),
              'retention.commandHistoryDays': String(v.commandHistoryRetention),
              'retention.playerSessionsDays': String(v.playerSessionsRetention),
              'retention.uiEventsDays': String(v.uiEventsRetention),
              'retention.migrationsDays': String(v.migrationsRetention),
              'retention.deletedBackupsDays': String(v.deletedBackupsRetention),
              'retention.tasksDays': String(v.tasksRetention),
              'metrics.intervalSec': String(v.metricsInterval),
              'schedule.timezone': v.scheduleTimezone,
              'agents.restoreOnBoot': v.restoreOnBoot ? 'true' : 'false',
              'agents.autoUpdate': v.autoUpdate ? '1' : '0',
              'panel.updateCheck.enabled': v.updateCheck ? 'true' : 'false',
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
            {t('web:settings.general.title')}
          </Title>
          <TextInput
            label={t('web:settings.general.publicUrl')}
            description={
              <>
                {t('web:settings.general.publicUrlHint')} <HelpLink topic="publicUrl" inline />
              </>
            }
            placeholder="https://panel.example.org"
            {...form.getInputProps('publicUrl')}
            data-testid="settings-public-url"
          />
          <TextInput
            label={t('web:settings.general.backupDestination')}
            description={t('web:settings.general.backupDestinationHint')}
            {...form.getInputProps('backupDestination')}
          />
          <NumberInput
            label={t('web:settings.general.metricsInterval')}
            min={5}
            max={300}
            {...form.getInputProps('metricsInterval')}
          />
          <div>
            <Text size="sm" fw={500}>
              {t('web:settings.general.retentionTitle')}
            </Text>
            <Text size="xs" c="dimmed">
              {t('web:settings.general.retentionHint')}
            </Text>
          </div>
          <SimpleGrid cols={{ base: 1, sm: 2, md: 4 }} spacing="sm">
            <NumberInput
              label={t('web:settings.general.eventsRetention')}
              min={1}
              max={3650}
              {...form.getInputProps('eventsRetention')}
              data-testid="settings-retention-events"
            />
            <NumberInput
              label={t('web:settings.general.auditRetention')}
              min={1}
              max={3650}
              {...form.getInputProps('auditRetention')}
              data-testid="settings-retention-audit"
            />
            <NumberInput
              label={t('web:settings.general.commandHistoryRetention')}
              min={1}
              max={3650}
              {...form.getInputProps('commandHistoryRetention')}
              data-testid="settings-retention-command-history"
            />
            <NumberInput
              label={t('web:settings.general.playerSessionsRetention')}
              min={1}
              max={3650}
              {...form.getInputProps('playerSessionsRetention')}
              data-testid="settings-retention-player-sessions"
            />
            <NumberInput
              label={t('web:settings.general.uiEventsRetention')}
              min={1}
              max={3650}
              {...form.getInputProps('uiEventsRetention')}
              data-testid="settings-retention-ui-events"
            />
            <NumberInput
              label={t('web:settings.general.migrationsRetention')}
              min={1}
              max={3650}
              {...form.getInputProps('migrationsRetention')}
              data-testid="settings-retention-migrations"
            />
            <NumberInput
              label={t('web:settings.general.deletedBackupsRetention')}
              min={1}
              max={3650}
              {...form.getInputProps('deletedBackupsRetention')}
              data-testid="settings-retention-deleted-backups"
            />
            <NumberInput
              label={t('web:settings.general.tasksRetention')}
              min={1}
              max={3650}
              {...form.getInputProps('tasksRetention')}
              data-testid="settings-retention-tasks"
            />
          </SimpleGrid>
          <Select
            label={t('web:settings.general.scheduleTimezone')}
            description={t('web:settings.general.scheduleTimezoneHint', {
              zone: describeTimeZone(form.values.scheduleTimezone, Date.now()),
            })}
            data={TIME_ZONES}
            searchable
            allowDeselect={false}
            {...form.getInputProps('scheduleTimezone')}
            data-testid="settings-schedule-timezone"
          />
          <Switch
            label={t('web:settings.general.restoreOnBoot')}
            {...form.getInputProps('restoreOnBoot', { type: 'checkbox' })}
          />
          <Switch
            label={t('web:settings.general.autoUpdate')}
            {...form.getInputProps('autoUpdate', { type: 'checkbox' })}
            data-testid="settings-auto-update"
          />
          <Switch
            label={t('web:settings.general.updateCheck')}
            description={t('web:settings.general.updateCheckHint')}
            {...form.getInputProps('updateCheck', { type: 'checkbox' })}
            data-testid="settings-update-check"
          />
          <Group justify="flex-end">
            <Button
              type="submit"
              size="xs"
              loading={update.isPending}
              data-testid="settings-general-save"
            >
              {t('web:common.save')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Card>
  );
}

/** Vie privée (lot 9) : les deux appels sortants qui concernent les joueurs, chacun avec son interrupteur. */
function PrivacyCard({ settings }: { settings: Record<string, string> }) {
  const { t, i18n } = useT();
  const update = useUpdateSettings();
  const form = useForm({
    initialValues: {
      // Absents tant que jamais modifiés : le défaut serveur est « activé ».
      mojangLookup: settings['privacy.mojangLookup'] !== 'false',
      externalAvatars: settings['privacy.externalAvatars'] !== 'false',
    },
  });
  return (
    <Card withBorder radius="md" padding="md" data-testid="settings-privacy">
      <form
        onSubmit={form.onSubmit((v) => {
          update.mutate(
            {
              'privacy.mojangLookup': v.mojangLookup ? 'true' : 'false',
              'privacy.externalAvatars': v.externalAvatars ? 'true' : 'false',
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
            {t('web:settings.privacy.title')}
          </Title>
          <Text size="xs" c="dimmed">
            {t('web:settings.privacy.hint')} <HelpLink topic="privacy" inline />
          </Text>
          <Switch
            label={t('web:settings.privacy.mojangLookup')}
            description={t('web:settings.privacy.mojangLookupHint')}
            {...form.getInputProps('mojangLookup', { type: 'checkbox' })}
            data-testid="settings-privacy-mojang"
          />
          <Switch
            label={t('web:settings.privacy.externalAvatars')}
            description={t('web:settings.privacy.externalAvatarsHint')}
            {...form.getInputProps('externalAvatars', { type: 'checkbox' })}
            data-testid="settings-privacy-avatars"
          />
          <Group justify="flex-end">
            <Button
              type="submit"
              size="xs"
              loading={update.isPending}
              data-testid="settings-privacy-save"
            >
              {t('web:common.save')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Card>
  );
}

function PushAdminCard() {
  const { t } = useT();
  const push = usePushStatus();
  const key = push.data?.vapidPublicKey ?? null;
  return (
    <Card withBorder radius="md" padding="md" data-testid="settings-push">
      <Stack gap="sm">
        <Title order={2} size="h4">
          {t('web:settings.push.title')}
        </Title>
        {push.data !== undefined &&
          (key === null ? (
            <Alert color="yellow">{t('web:settings.push.vapidMissing')}</Alert>
          ) : (
            <>
              <Text size="sm">{t('web:settings.push.vapidReady')}</Text>
              <Text size="xs" c="dimmed">
                {t('web:settings.push.publicKey')} : <Code>{key}</Code>
              </Text>
            </>
          ))}
      </Stack>
    </Card>
  );
}

export function SettingsPage() {
  const { t } = useT();
  const settings = useSettings();
  return (
    <Stack gap="lg" data-testid="settings-page">
      <Title order={1} size="h2">
        {t('web:settings.title')}
      </Title>
      {settings.data !== undefined && <GeneralCard settings={settings.data.settings} />}
      {settings.data !== undefined && <PrivacyCard settings={settings.data.settings} />}
      <UsersCard />
      <ApiKeysCard all />
      <AccessCard />
      <DistributionCard />
      <PanelBackupsCard />
      <PushAdminCard />
      <WebhooksCard />
      <AuditCard />
    </Stack>
  );
}
