/**
 * i18n partagée (doc 03 §7) : i18next, ressources `fr`/`en` typées, instance isolée par appel
 * (le panel localise les push selon le destinataire ; le front branche `react-i18next` sur `resources`).
 */
import i18next, { type i18n as I18nInstance } from 'i18next';

import { en, type Resources } from './locales/en.js';
import { fr } from './locales/fr.js';

export const LOCALES = ['fr', 'en'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'fr';

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

/** Normalise une langue navigateur (`fr-FR`, `en_US`, `de`) vers une locale supportée. */
export function resolveLocale(
  value: string | undefined,
  fallback: Locale = DEFAULT_LOCALE,
): Locale {
  if (!value) return fallback;
  const base = value.toLowerCase().split(/[-_]/)[0] ?? '';
  return isLocale(base) ? base : fallback;
}

export const NAMESPACES = ['common', 'errors', 'detection'] as const;
export type Namespace = (typeof NAMESPACES)[number];

/** Ressources au format i18next (`{ fr: { common, errors, detection }, en: … }`). */
export const resources: Record<Locale, Resources> = { fr, en };

export type { Resources };

/** Crée une instance i18next indépendante, initialisée de façon synchrone. */
export function createI18n(locale: Locale = DEFAULT_LOCALE): I18nInstance {
  const instance = i18next.createInstance();
  void instance.init({
    lng: locale,
    fallbackLng: 'en',
    supportedLngs: [...LOCALES],
    resources,
    defaultNS: 'common',
    ns: [...NAMESPACES],
    interpolation: { escapeValue: false },
    initAsync: false,
    returnNull: false,
  });
  return instance;
}

/** Traduit une erreur protocole (`code` + `details`) dans la langue demandée. */
export function translateError(
  i18n: I18nInstance,
  error: { code: string; details?: Record<string, unknown> | undefined },
): string {
  const key = `errors:${error.code}`;
  if (!i18n.exists(key)) return i18n.t('errors:E_INTERNAL');
  return i18n.t(key, { ...error.details });
}

/** Traduit un indice de détection (`{ code, detail }`). */
export function translateEvidence(
  i18n: I18nInstance,
  evidence: { code: string; detail?: string | undefined },
): string {
  const key = `detection:evidence.${evidence.code}`;
  if (!i18n.exists(key)) return evidence.detail ?? evidence.code;
  return i18n.t(key, { detail: evidence.detail ?? '' });
}
