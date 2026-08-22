/**
 * i18n du front (doc 03 §7) : i18next + react-i18next branchés sur `resources` de `@mmo/shared`
 * (common / errors / detection) complétées par l'espace de noms `web` (chaînes d'interface).
 * Langue initiale : préférence locale (`mmo.locale`), sinon langue du navigateur, sinon `fr`.
 */
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';

import {
  DEFAULT_LOCALE,
  LOCALES,
  isLocale,
  resolveLocale,
  resources as sharedResources,
  type Locale,
} from '@mmo/shared';

import { webEn } from './locales/en.js';
import { webFr } from './locales/fr.js';

export const LOCALE_STORAGE_KEY = 'mmo.locale';

export const webResources = {
  fr: { ...sharedResources.fr, web: webFr },
  en: { ...sharedResources.en, web: webEn },
} as const;

export function initialLocale(
  storage: Pick<Storage, 'getItem'> = globalThis.localStorage,
  navigatorLanguage: string | undefined = globalThis.navigator.language,
): Locale {
  const stored = storage.getItem(LOCALE_STORAGE_KEY);
  if (stored !== null && isLocale(stored)) return stored;
  return resolveLocale(navigatorLanguage, DEFAULT_LOCALE);
}

export const i18n = i18next.createInstance();
void i18n.use(initReactI18next).init({
  lng: initialLocale(),
  fallbackLng: 'en',
  supportedLngs: [...LOCALES],
  resources: webResources,
  defaultNS: 'web',
  ns: ['web', 'common', 'errors', 'detection'],
  interpolation: { escapeValue: false },
  initAsync: false,
  returnNull: false,
});
document.documentElement.lang = i18n.language;

/** Change la langue (persistée localement ; la préférence serveur est mise à jour par l'appelant). */
export function setLocale(locale: Locale): void {
  localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  void i18n.changeLanguage(locale);
  document.documentElement.lang = locale;
}

export function currentLocale(): Locale {
  return resolveLocale(i18n.language, DEFAULT_LOCALE);
}

/** Traduction par clé dynamique (types d'événements, codes) — contourne le typage strict des clés. */
export function tDynamic(
  instance: { t: unknown },
  key: string,
  options?: Record<string, unknown>,
): string {
  return (instance.t as (k: string, o?: Record<string, unknown>) => string)(key, options);
}
