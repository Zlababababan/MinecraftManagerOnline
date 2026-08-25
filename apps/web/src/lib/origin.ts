/**
 * Tolérance de saisie de l'URL publique (miroir de `coerceOrigin` côté panel) : sans schéma,
 * `https://` est supposé — coller `panel.tailnet.ts.net` suffit. Le panel revalide strictement.
 */
export function coerceOriginInput(value: string): string {
  const v = value.trim().replace(/\/+$/, '');
  if (v === '') return '';
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(v) ? v : `https://${v}`;
}

/** Valide la valeur telle que le panel l'acceptera (origine http(s) sans chemin) ; vide = OK. */
export function isValidOriginInput(value: string): boolean {
  const v = coerceOriginInput(value);
  return v === '' || /^https?:\/\/[^\s/]+$/.test(v);
}
