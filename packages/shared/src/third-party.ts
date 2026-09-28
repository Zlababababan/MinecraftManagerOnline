/**
 * Services tiers auxquels le produit parle, et ce qui reste à **vérifier** avant de s'y fier dans
 * un produit commercialisable (règle du projet : tout commercialisable, même pour tester).
 *
 * Une entrée `verified: false` fait apparaître, pour les administrateurs seulement, une petite note
 * discrète là où le service est employé (« À vérifier : … »), et une ligne dans Réglages →
 * Services tiers. Quand la vérification est faite : passer `verified` à `true` et noter la source
 * dans `docs/services-tiers.md` — les notes disparaissent d'elles-mêmes.
 *
 * Les textes (nom, usage, ce qu'il faut vérifier) sont dans les traductions de l'interface
 * (`web:thirdParty.services.<id>.*`) ; ici ne vivent que l'identité et l'état.
 */
const SERVICES = [
  /** API des modpacks FTB (intégration retirable, réglage `modpacks.ftb.enabled`). */
  { id: 'ftb', hosts: ['api.feed-the-beast.com', 'files.feed-the-beast.com'], verified: false },
  /** Fichiers de mods hébergés par CurseForge, téléchargés directement pour un pack FTB. */
  { id: 'curseforge', hosts: ['edge.forgecdn.net'], verified: false },
  /** Manifest des versions et jars serveur de Mojang ; recherche de profils (pseudo → UUID). */
  {
    id: 'mojang',
    hosts: ['piston-meta.mojang.com', 'piston-data.mojang.com', 'api.minecraftservices.com'],
    verified: false,
  },
  /** Têtes des joueurs affichées par le navigateur (réglage `privacy.externalAvatars`). */
  { id: 'mcHeads', hosts: ['mc-heads.net'], verified: false },
  { id: 'fabric', hosts: ['meta.fabricmc.net'], verified: false },
  /** Forge vit en partie de la publicité de sa page de téléchargement. */
  {
    id: 'forge',
    hosts: ['maven.minecraftforge.net', 'files.minecraftforge.net'],
    verified: false,
  },
  { id: 'neoforge', hosts: ['maven.neoforged.net'], verified: false },
  { id: 'adoptium', hosts: ['api.adoptium.net'], verified: false },
  { id: 'azul', hosts: ['api.azul.com'], verified: false },
  { id: 'spark', hosts: ['sparkapi.lucko.me', 'spark.lucko.me'], verified: false },
  /** Mode d'accès direct : le panel accepte les conditions de Let's Encrypt en demandant un certificat. */
  { id: 'letsEncrypt', hosts: ['acme-v02.api.letsencrypt.org'], verified: false },
] as const satisfies readonly { id: string; hosts: readonly string[]; verified: boolean }[];

export type ThirdPartyServiceId = (typeof SERVICES)[number]['id'];

export interface ThirdPartyService {
  id: ThirdPartyServiceId;
  hosts: readonly string[];
  /** `false` tant qu'un point reste à confirmer (voir `web:thirdParty.services.<id>.check`). */
  verified: boolean;
}

/** Typée en `boolean` exprès : passer une entrée à `true` ne doit rien changer d'autre. */
export const THIRD_PARTY_SERVICES: readonly ThirdPartyService[] = SERVICES;

/** Le service a-t-il encore une vérification en attente ? */
export function thirdPartyToVerify(id: ThirdPartyServiceId): boolean {
  return THIRD_PARTY_SERVICES.some((s) => s.id === id && !s.verified);
}
