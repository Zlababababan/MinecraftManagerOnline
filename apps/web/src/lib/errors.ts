/** Traduction des erreurs pour l'UI : codes API → chaînes `errors:*` de `@mmo/shared`. */
import type { i18n as I18nInstance } from 'i18next';

import { translateError } from '@mmo/shared';

import { ApiRequestError, NetworkError } from '../api/client.js';

export function describeError(i18n: I18nInstance, error: unknown): string {
  if (error instanceof ApiRequestError) {
    const translated = translateError(i18n, { code: error.code, details: error.details });
    if (error.code === 'E_VALIDATION') {
      const issues = error.details.issues;
      if (Array.isArray(issues) && issues.length > 0) {
        const first = issues[0] as { path?: string; message?: string };
        return `${translated} ${first.path ?? ''} ${first.message ?? ''}`.trim();
      }
    }
    return translated;
  }
  if (error instanceof NetworkError) return i18n.t('errors.network', { ns: 'web' });
  if (error instanceof Error && error.message !== '') return error.message;
  return i18n.t('errors.unknown', { ns: 'web' });
}
