/** Connexion (cookie `mmo_session`) ; redirige vers la page demandée (`?redirect=`) ou le dashboard. */
import {
  Button,
  Card,
  Center,
  Group,
  PasswordInput,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useT } from '../i18n/hooks.js';

import { useLogin } from '../api/queries.js';
import { ErrorAlert } from '../components/ErrorAlert.js';
import { LanguageMenu, ThemeMenu } from '../components/Shell.js';
import { setLocale } from '../i18n/index.js';

export function LoginPage() {
  const { t } = useT();
  const navigate = useNavigate();
  const search = useSearch({ from: '/login' });
  const login = useLogin();
  const form = useForm({
    initialValues: { username: '', password: '' },
    validate: {
      username: (v) => (v.trim() === '' ? t('web:errors.validation') : null),
      password: (v) => (v === '' ? t('web:errors.validation') : null),
    },
  });

  const submit = form.onSubmit((values) => {
    login.mutate(values, {
      onSuccess: (data) => {
        setLocale(data.user.locale);
        const target = search.redirect;
        void navigate({ to: target?.startsWith('/') === true ? target : '/' });
      },
    });
  });

  return (
    <Center mih="100vh" p="md">
      <Card withBorder radius="md" p="xl" w="100%" maw={420} data-testid="login">
        <form onSubmit={submit}>
          <Stack gap="md">
            <Group justify="space-between" align="flex-start">
              <div>
                <Title order={1} size="h2">
                  {t('web:auth.title')}
                </Title>
                <Text c="dimmed" size="sm">
                  {t('web:app.name')}
                </Text>
              </div>
              <Group gap={4}>
                <ThemeMenu />
                <LanguageMenu />
              </Group>
            </Group>
            <TextInput
              label={t('web:auth.username')}
              autoComplete="username"
              autoFocus
              required
              data-testid="login-username"
              {...form.getInputProps('username')}
            />
            <PasswordInput
              label={t('web:auth.password')}
              autoComplete="current-password"
              required
              data-testid="login-password"
              {...form.getInputProps('password')}
            />
            <ErrorAlert error={login.error} />
            <Button type="submit" loading={login.isPending} fullWidth data-testid="login-submit">
              {t('web:auth.submit')}
            </Button>
          </Stack>
        </form>
      </Card>
    </Center>
  );
}
