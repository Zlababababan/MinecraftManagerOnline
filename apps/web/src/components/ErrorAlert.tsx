/** Affichage d'une erreur (API, réseau, inattendue) traduite à partir de son code. */
import { Alert, type AlertProps } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useT } from '../i18n/hooks.js';

import { describeError } from '../lib/errors.js';

export function ErrorAlert({ error, ...props }: { error: unknown } & AlertProps) {
  const { t, i18n } = useT();
  if (error === null || error === undefined) return null;
  return (
    <Alert
      color="red"
      variant="light"
      icon={<IconAlertTriangle size={18} />}
      title={t('web:common.error')}
      role="alert"
      {...props}
    >
      {describeError(i18n, error)}
    </Alert>
  );
}
