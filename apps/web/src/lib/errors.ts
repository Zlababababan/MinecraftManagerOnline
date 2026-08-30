/** Traduction des erreurs pour l'UI : codes API → chaînes `errors:*` de `@mmo/shared`. */
import type { i18n as I18nInstance } from 'i18next';

import { translateError } from '@mmo/shared';

import { ApiRequestError, NetworkError } from '../api/client.js';

export function describeError(i18n: I18nInstance, error: unknown): string {
  if (error instanceof ApiRequestError) {
    const translated = translateError(i18n, { code: error.code, details: error.details });
    // Code de repli ou code sans traduction : la phrase générique ne dit rien par construction,
    // alors que le message du serveur porte la vraie cause. Le jeter était le défaut le plus
    // coûteux du produit — « Start internal error » cachait un
    // « EACCES: permission denied, open '…/server.properties' » parfaitement explicite.
    if (
      (error.code === 'E_INTERNAL' || !i18n.exists(`errors:${error.code}`)) &&
      error.message.trim() !== ''
    ) {
      return `${translated} ${error.message}`.trim();
    }
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
