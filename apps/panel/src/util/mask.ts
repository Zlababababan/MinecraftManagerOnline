/**
 * Masquage de ce qu'un texte de diagnostic peut trahir — partagé par `mmo-panel report` et par le
 * fichier de diagnostic d'un agent (`GET /api/machines/:id/diagnostics`, lot 9). Volontairement
 * grossier : mieux vaut retirer un chemin utile qu'un nom d'utilisateur, et l'utilisateur relit de
 * toute façon le fichier avant de le publier.
 */
export function maskLine(line: string): string {
  return (
    line
      // Répertoires personnels : `C:\Users\Jean\…`, `/home/jean/…`, `/Users/jean/…`
      .replace(/([A-Za-z]:\\Users\\)[^\\\s"']+/gi, '$1<user>')
      .replace(/(\/(?:home|Users)\/)[^/\s"']+/g, '$1<user>')
      // Codes d'appairage (MMOP-XXXX-XXXX) et secrets nommés
      .replace(/MMOP-[A-Z0-9]{4}-[A-Z0-9]{4}/gi, 'MMOP-<code>')
      // La valeur s'arrête au premier guillemet : sinon le guillemet fermant part avec elle et la
      // ligne devient illisible (`"password": "<redacted>` jamais refermé).
      .replace(
        /((?:token|secret|password|passwd|pwd|apikey|api_key|authorization)\b["'\s:=]{1,6})[^\s"',;]+/gi,
        '$1<redacted>',
      )
      // Adresses : IPv4 sans son dernier octet, IPv6 sans sa moitié basse. La boucle locale et
      // `0.0.0.0` restent intactes — les tronquer ne protège personne et rend le rapport confus,
      // alors que « le panel écoute sur 127.0.0.1 » est justement ce qu'on cherche à lire.
      .replace(/\b(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}\b/g, (match, prefix: string) =>
        match === '0.0.0.0' || prefix.startsWith('127.') ? match : `${prefix}.x`,
      )
      .replace(/\b([0-9a-f]{1,4}:[0-9a-f]{1,4}:[0-9a-f]{1,4}):[0-9a-f:]+\b/gi, '$1:…')
  );
}

/** Masque un texte multi-lignes, ligne par ligne. */
export function maskText(text: string): string {
  return text.split('\n').map(maskLine).join('\n');
}
