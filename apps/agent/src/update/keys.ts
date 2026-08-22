/**
 * Clés publiques Ed25519 (SPKI DER base64) acceptées pour les bundles agent (doc 03 §3) : la clé
 * privée correspondante vit chez le mainteneur, jamais sur le panel — un panel compromis ne peut pas
 * pousser de code arbitraire. Plusieurs clés = rotation possible. La clé ci-dessous est la clé de
 * **développement** (`tools/signing/dev.private.pem`). Phase 11 : ajouter ici la clé publique de release
 * (générée par `tools/signing/keygen.mjs`, privée hors dépôt) **avant** de signer avec elle ; garder la clé
 * de dev tant que des agents signés par elle existent, puis la retirer (rotation).
 */
export const AGENT_UPDATE_PUBLIC_KEYS: readonly string[] = [
  'MCowBQYDK2VwAyEAR5uDa6jNinbjRtOdBPBDA7gQ1nvDOEXecSBWQfG9Cnk=',
];
