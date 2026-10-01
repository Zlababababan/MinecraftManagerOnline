/**
 * Copier un texte dans le presse-papiers, y compris hors « contexte sécurisé ».
 *
 * `navigator.clipboard` n'existe qu'en HTTPS ou sur localhost : un panel ouvert par son adresse
 * IPv6 en HTTP (le cas de Yassin depuis un autre appareil) n'y a pas droit. On retombe alors sur
 * l'ancienne voie (`execCommand('copy')` sur un champ invisible). Rend `false` si rien n'a marché :
 * à l'appelant d'afficher le texte pour qu'on puisse le copier à la main.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await globalThis.navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Pas de presse-papiers moderne (HTTP), ou permission refusée : voie de repli.
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- seule voie hors contexte sécurisé
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}
