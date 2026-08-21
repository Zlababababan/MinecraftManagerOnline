/**
 * @mmo/shared — code commun panel/agent.
 * Phase 2 y ajoutera : i18n fr/en, mapping MC→Java, parsing de logs, heuristiques de détection.
 */

export const PROJECT_NAME = 'MinecraftManagerOnline';

/** Langues supportées (i18n dès la première chaîne — doc 07, règle 4). */
export const LOCALES = ['fr', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}
