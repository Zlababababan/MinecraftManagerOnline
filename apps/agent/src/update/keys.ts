/**
 * Clés publiques Ed25519 (SPKI DER base64) acceptées pour les bundles agent (doc 03 §3) : la clé
 * privée correspondante vit chez le mainteneur, jamais sur le panel — un panel compromis ne peut pas
 * pousser de code arbitraire. Plusieurs clés = rotation possible. La clé ci-dessous est la clé de
 * **développement** (`tools/signing/dev.private.pem`) ; une clé de release la remplacera en phase 11.
 */
export const AGENT_UPDATE_PUBLIC_KEYS: readonly string[] = [
  'MCowBQYDK2VwAyEAR5uDa6jNinbjRtOdBPBDA7gQ1nvDOEXecSBWQfG9Cnk=',
];
