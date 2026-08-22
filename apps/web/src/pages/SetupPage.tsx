/** Wizard first-run (doc 03 §8) : compte admin + accès → `POST /api/setup`, puis dashboard. */
import {
  Button,
  Card,
  Center,
  Group,
  PasswordInput,
  Select,
  Stack,
  Stepper,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useT } from '../i18n/hooks.js';

import { passwordSchema, usernameSchema } from '@mmo/protocol/client';
import { isLocale } from '@mmo/shared';

import { useSetup } from '../api/queries.js';
import { ErrorAlert } from '../components/ErrorAlert.js';
import { LanguageMenu, ThemeMenu } from '../components/Shell.js';
import { currentLocale, setLocale } from '../i18n/index.js';

interface SetupForm {
  username: string;
  password: string;
  passwordConfirm: string;
  locale: 'fr' | 'en';
  publicUrl: string;
  accessMode: 'tailscale' | 'direct' | 'manual';
  backupDestination: string;
}

export function SetupPage() {
  const { t } = useT();
  const navigate = useNavigate();
  const setup = useSetup();
  const [step, setStep] = useState(0);
  const form = useForm<SetupForm>({
    initialValues: {
      username: '',
      password: '',
      passwordConfirm: '',
      locale: currentLocale(),
      publicUrl: '',
      accessMode: 'tailscale',
      backupDestination: '',
    },
    validate: {
      username: (v) => (usernameSchema.safeParse(v).success ? null : t('web:setup.usernameHint')),
      password: (v) => (passwordSchema.safeParse(v).success ? null : t('web:setup.passwordHint')),
      passwordConfirm: (v, values) =>
        v === values.password ? null : t('web:setup.passwordMismatch'),
      publicUrl: (v) =>
        v === '' || /^https?:\/\/[^\s/]+/.test(v) ? null : t('web:errors.validation'),
    },
  });

  const next = (): void => {
    const result = form.validate();
    const accountErrors = ['username', 'password', 'passwordConfirm'].filter(
      (k) => result.errors[k] !== undefined,
    );
    if (accountErrors.length === 0) setStep(1);
  };

  const submit = form.onSubmit((values) => {
    setup.mutate(
      {
        username: values.username,
        password: values.password,
        locale: values.locale,
        accessMode: values.accessMode,
        ...(values.publicUrl === '' ? {} : { publicUrl: values.publicUrl.replace(/\/+$/, '') }),
        ...(values.backupDestination === '' ? {} : { backupDestination: values.backupDestination }),
      },
      {
        onSuccess: () => {
          void navigate({ to: '/' });
        },
      },
    );
  });

  return (
    <Center mih="100vh" p="md">
      <Card withBorder radius="md" p="xl" w="100%" maw={560} data-testid="setup">
        <form onSubmit={submit}>
          <Stack gap="md">
            <Group justify="space-between" align="flex-start">
              <div>
                <Title order={2}>{t('web:setup.title')}</Title>
                <Text c="dimmed" size="sm">
                  {t('web:setup.intro')}
                </Text>
              </div>
              <Group gap={4}>
                <ThemeMenu />
                <LanguageMenu
                  onChange={(locale) => {
                    form.setFieldValue('locale', locale);
                  }}
                />
              </Group>
            </Group>
            <Stepper active={step} size="sm" allowNextStepsSelect={false}>
              <Stepper.Step label={t('web:setup.account')}>
                <Stack gap="sm" mt="md">
                  <TextInput
                    label={t('web:setup.username')}
                    description={t('web:setup.usernameHint')}
                    autoComplete="username"
                    required
                    data-testid="setup-username"
                    {...form.getInputProps('username')}
                  />
                  <PasswordInput
                    label={t('web:setup.password')}
                    description={t('web:setup.passwordHint')}
                    autoComplete="new-password"
                    required
                    data-testid="setup-password"
                    {...form.getInputProps('password')}
                  />
                  <PasswordInput
                    label={t('web:setup.passwordConfirm')}
                    autoComplete="new-password"
                    required
                    data-testid="setup-password-confirm"
                    {...form.getInputProps('passwordConfirm')}
                  />
                  <Select
                    label={t('web:setup.locale')}
                    data={[
                      { value: 'fr', label: t('web:lang.fr') },
                      { value: 'en', label: t('web:lang.en') },
                    ]}
                    allowDeselect={false}
                    {...form.getInputProps('locale')}
                    onChange={(value) => {
                      if (value !== null && isLocale(value)) {
                        form.setFieldValue('locale', value);
                        setLocale(value);
                      }
                    }}
                  />
                </Stack>
              </Stepper.Step>
              <Stepper.Step label={t('web:setup.access')}>
                <Stack gap="sm" mt="md">
                  <TextInput
                    label={t('web:setup.publicUrl')}
                    description={t('web:setup.publicUrlHint')}
                    placeholder="https://panel.example.ts.net"
                    inputMode="url"
                    data-testid="setup-public-url"
                    {...form.getInputProps('publicUrl')}
                  />
                  <Select
                    label={t('web:setup.accessMode')}
                    data={[
                      { value: 'tailscale', label: t('web:setup.accessModes.tailscale') },
                      { value: 'direct', label: t('web:setup.accessModes.direct') },
                      { value: 'manual', label: t('web:setup.accessModes.manual') },
                    ]}
                    allowDeselect={false}
                    {...form.getInputProps('accessMode')}
                  />
                  <TextInput
                    label={t('web:setup.backupDestination')}
                    description={t('web:setup.backupDestinationHint')}
                    {...form.getInputProps('backupDestination')}
                  />
                </Stack>
              </Stepper.Step>
            </Stepper>
            <ErrorAlert error={setup.error} />
            <Group justify="space-between">
              {step > 0 ? (
                <Button
                  type="button"
                  variant="subtle"
                  onClick={() => {
                    setStep(0);
                  }}
                >
                  {t('web:common.back')}
                </Button>
              ) : (
                <span />
              )}
              {step === 0 ? (
                <Button key="next" type="button" onClick={next} data-testid="setup-next">
                  {t('web:setup.access')} →
                </Button>
              ) : (
                <Button
                  key="submit"
                  type="submit"
                  loading={setup.isPending}
                  data-testid="setup-submit"
                >
                  {t('web:setup.submit')}
                </Button>
              )}
            </Group>
          </Stack>
        </form>
      </Card>
    </Center>
  );
}
