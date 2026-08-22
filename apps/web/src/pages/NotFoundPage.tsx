/** 404 applicatif (route inconnue). */
import { Center, Stack, Text, Title } from '@mantine/core';
import { RouterAnchor } from '../components/links.js';
import { useT } from '../i18n/hooks.js';

export function NotFoundPage() {
  const { t } = useT();
  return (
    <Center mih="60vh">
      <Stack align="center" gap="xs">
        <Title order={2}>404</Title>
        <Text c="dimmed">{t('web:common.notFound')}</Text>
        <RouterAnchor to="/">{t('web:nav.dashboard')}</RouterAnchor>
      </Stack>
    </Center>
  );
}
