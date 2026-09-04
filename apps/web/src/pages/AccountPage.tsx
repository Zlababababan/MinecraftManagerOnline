/** Compte : profil (langue, thème persistés via `PATCH /api/auth/me`), changement de mot de passe. */
import {
  Button,
  Card,
  Group,
  PasswordInput,
  Select,
  SimpleGrid,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { useMantineColorScheme } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useT } from '../i18n/hooks.js';

import { passwordSchema, type UserDto } from '@mmo/protocol/client';
import { isLocale } from '@mmo/shared';

import { useUpdateMe } from '../api/queries.js';
import { SessionsCard } from '../components/account/SessionsCard.js';
import { ApiKeysCard } from '../components/admin/ApiKeysCard.js';
import { ErrorAlert } from '../components/ErrorAlert.js';
import {
  NotificationPrefsCard,
  PushCard,
} from '../components/notifications/NotificationSettings.js';
import { QuietHoursCard } from '../components/notifications/QuietHoursCard.js';
import { setLocale } from '../i18n/index.js';
import { describeError } from '../lib/errors.js';

export function AccountPage({ user }: { user: UserDto }) {
  const { t, i18n } = useT();
  const update = useUpdateMe();
  const { setColorScheme } = useMantineColorScheme();
  const pwd = useForm({
    initialValues: { currentPassword: '', newPassword: '', confirm: '' },
    validate: {
      currentPassword: (v) => (v === '' ? t('web:errors.validation') : null),
      newPassword: (v) =>
        passwordSchema.safeParse(v).success ? null : t('web:setup.passwordHint'),
      confirm: (v, values) => (v === values.newPassword ? null : t('web:setup.passwordMismatch')),
    },
  });
  const theme = ['light', 'dark', 'auto'].includes(user.theme) ? user.theme : 'auto';

  return (
    <Stack gap="lg" data-testid="account-page">
      <Title order={1} size="h2">
        {t('web:account.title')}
      </Title>
      <Card withBorder radius="md" padding="md">
        <Stack gap="sm">
          <Title order={2} size="h4">
            {t('web:account.profile')}
          </Title>
          <Text size="sm">
            {user.username} · {t(`web:role.${user.role}`)}
          </Text>
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
            <Select
              label={t('web:lang.label')}
              value={user.locale}
              allowDeselect={false}
              data={[
                { value: 'fr', label: t('web:lang.fr') },
                { value: 'en', label: t('web:lang.en') },
              ]}
              onChange={(value) => {
                if (value !== null && isLocale(value)) {
                  setLocale(value);
                  update.mutate(
                    { locale: value },
                    {
                      onSuccess: () => {
                        notifications.show({ color: 'teal', message: t('web:account.saved') });
                      },
                    },
                  );
                }
              }}
              data-testid="account-locale"
            />
            <Select
              label={t('web:theme.label')}
              value={theme}
              allowDeselect={false}
              data={[
                { value: 'light', label: t('web:theme.light') },
                { value: 'dark', label: t('web:theme.dark') },
                { value: 'auto', label: t('web:theme.auto') },
              ]}
              onChange={(value) => {
                if (value === 'light' || value === 'dark' || value === 'auto') {
                  setColorScheme(value);
                  update.mutate({ theme: value });
                }
              }}
            />
          </SimpleGrid>
        </Stack>
      </Card>
      <Card withBorder radius="md" padding="md">
        <form
          onSubmit={pwd.onSubmit((values) => {
            update.mutate(
              { currentPassword: values.currentPassword, newPassword: values.newPassword },
              {
                onSuccess: () => {
                  pwd.reset();
                  notifications.show({ color: 'teal', message: t('web:account.passwordChanged') });
                },
                onError: (error) => {
                  notifications.show({ color: 'red', message: describeError(i18n, error) });
                },
              },
            );
          })}
        >
          <Stack gap="sm" maw={420}>
            <Title order={2} size="h4">
              {t('web:account.password')}
            </Title>
            <PasswordInput
              label={t('web:account.currentPassword')}
              autoComplete="current-password"
              {...pwd.getInputProps('currentPassword')}
            />
            <PasswordInput
              label={t('web:account.newPassword')}
              autoComplete="new-password"
              {...pwd.getInputProps('newPassword')}
            />
            <PasswordInput
              label={t('web:setup.passwordConfirm')}
              autoComplete="new-password"
              {...pwd.getInputProps('confirm')}
            />
            <ErrorAlert error={update.error} />
            <Group justify="flex-end">
              <Button type="submit" loading={update.isPending}>
                {t('web:common.save')}
              </Button>
            </Group>
          </Stack>
        </form>
      </Card>
      <SessionsCard />
      <ApiKeysCard />
      <PushCard />
      <QuietHoursCard />
      <NotificationPrefsCard />
    </Stack>
  );
}
