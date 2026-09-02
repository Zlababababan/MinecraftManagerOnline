/**
 * Réglages de vie privée connus du navigateur (lot 9), reçus avec `/api/auth/me` et lus de façon
 * synchrone par les composants — `PlayerAvatar` est monté partout où un joueur apparaît, et un
 * hook de requête dans ce composant casserait tous les tests qui le montent sans fournisseur.
 *
 * Défaut « avatars autorisés » tant que rien n'est reçu : c'est le comportement historique, et un
 * panel qui a coupé les avatars le dit dès la première réponse, avant que la première liste de
 * joueurs ne s'affiche.
 */
let externalAvatars = true;

export interface PrivacyPreferences {
  externalAvatars: boolean;
}

export function configurePrivacy(preferences: Partial<PrivacyPreferences> | undefined): void {
  if (preferences?.externalAvatars !== undefined) externalAvatars = preferences.externalAvatars;
}

/** Le navigateur peut-il aller chercher la tête d'un joueur chez mc-heads.net ? */
export function externalAvatarsEnabled(): boolean {
  return externalAvatars;
}
