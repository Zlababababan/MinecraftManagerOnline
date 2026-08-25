/**
 * Origine HTTP(S) stricte — `https://hôte[:port]` sans chemin, identifiants ni fragment — seule
 * forme acceptée pour `panel.publicUrl` et pour l'origine d'une requête (phase 12, doc 03 §6) :
 * cette valeur est injectée dans `install.ps1` / `install.sh` (entre quotes) et dans les push.
 */
const ORIGIN =
  /^https?:\/\/(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9](?:[A-Za-z0-9.-]{0,252}[A-Za-z0-9])?)(?::\d{1,5})?$/;

export function isStrictOrigin(value: string): boolean {
  return value.length <= 300 && ORIGIN.test(value);
}

/** Normalise (slash final retiré) et valide ; `undefined` si invalide. */
export function normalizeOrigin(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const v = value.trim().replace(/\/+$/, '');
  return isStrictOrigin(v) ? v : undefined;
}

/**
 * Tolérance de saisie (URL publique tapée par l'utilisateur) : sans schéma, `https://` est
 * supposé — `panel.tailnet.ts.net` devient `https://panel.tailnet.ts.net`. Réservé aux champs
 * de formulaire ; les origines lues des requêtes ou du stockage restent validées strictement.
 */
export function coerceOrigin(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const v = value.trim();
  if (v === '') return undefined;
  return normalizeOrigin(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(v) ? v : `https://${v}`);
}
