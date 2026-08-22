/** `useT()` = `useTranslation` sur tous les espaces de noms : clés typées `web:…`, `common:…`, `errors:…`, `detection:…`. */
import { useTranslation } from 'react-i18next';

export const ALL_NAMESPACES = ['web', 'common', 'errors', 'detection'] as const;

export function useT() {
  return useTranslation(ALL_NAMESPACES);
}
