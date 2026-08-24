/**
 * Clés publiques Ed25519 (SPKI DER base64) acceptées pour les bundles agent (doc 03 §3) : la clé
 * privée correspondante vit chez le mainteneur, jamais sur le panel — un panel compromis ne peut pas
 * pousser de code arbitraire. Plusieurs clés = rotation possible.
 *
 * Phase 12 : `RELEASE_KEYS` = clé de release 1.0 (privée hors dépôt, `tools/signing/keygen.mjs`).
 * La clé de **développement** (`tools/signing/dev.private.pem`, privée publique dans le dépôt) n'est
 * acceptée que par les bundles de développement/test : `tools/release/build.mjs --release` fixe
 * `MMO_RELEASE_BUILD=1`, remplacé à la compilation (esbuild `define`), et le bundle publié ne
 * contient alors que les clés de release.
 */
const RELEASE_KEYS: readonly string[] = [
  'MCowBQYDK2VwAyEAiUDWJLKR+sl8iyPeWm3DEVze+zj+an5PAoQVviUh/Sc=',
];

const DEV_KEY = 'MCowBQYDK2VwAyEAR5uDa6jNinbjRtOdBPBDA7gQ1nvDOEXecSBWQfG9Cnk=';

export const AGENT_UPDATE_PUBLIC_KEYS: readonly string[] =
  process.env.MMO_RELEASE_BUILD === '1' ? RELEASE_KEYS : [...RELEASE_KEYS, DEV_KEY];
