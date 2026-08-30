/**
 * Props des champs « techniques » : commandes de console, chemins, pseudos, adresses IP, clés de
 * `server.properties`, noms de fichiers, hôtes. Sur iOS, le clavier met une majuscule au premier
 * mot et autocorrige : `say bonjour` devient `Say bonjour` et un chemin `E:\Minecraft\Server`
 * saisi au téléphone est massacré. Ne PAS appliquer aux champs de texte humain (motif d'un ban,
 * description) où l'autocorrection est souhaitable.
 */
export const TECHNICAL_INPUT_PROPS = {
  autoCapitalize: 'off',
  autoCorrect: 'off',
  autoComplete: 'off',
  spellCheck: false,
} as const;
