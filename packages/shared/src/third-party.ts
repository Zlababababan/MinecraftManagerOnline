/**
 * Services tiers auxquels le produit parle : ce que montre Réglages → Services tiers, pour que la
 * personne qui tient le panel sache ce qui sort de chez elle. Les règles de politesse envers ces
 * services sont dans `docs/services-tiers.md`.
 *
 * Les textes (nom, usage) sont dans les traductions de l'interface
 * (`web:thirdParty.services.<id>.*`) ; ici ne vit que l'identité.
 */
const SERVICES = [
  /** API des modpacks FTB (intégration retirable, réglage `modpacks.ftb.enabled`). */
  { id: 'ftb', hosts: ['api.feed-the-beast.com', 'files.feed-the-beast.com'] },
  /** Fichiers de mods hébergés par CurseForge, téléchargés directement pour un pack FTB. */
  { id: 'curseforge', hosts: ['edge.forgecdn.net'] },
  /** Manifest des versions et jars serveur de Mojang ; recherche de profils (pseudo → UUID). */
  {
    id: 'mojang',
    hosts: ['piston-meta.mojang.com', 'piston-data.mojang.com', 'api.minecraftservices.com'],
  },
  /** Têtes des joueurs affichées par le navigateur (réglage `privacy.externalAvatars`). */
  { id: 'mcHeads', hosts: ['mc-heads.net'] },
  { id: 'fabric', hosts: ['meta.fabricmc.net'] },
  { id: 'forge', hosts: ['maven.minecraftforge.net', 'files.minecraftforge.net'] },
  { id: 'neoforge', hosts: ['maven.neoforged.net'] },
  { id: 'adoptium', hosts: ['api.adoptium.net'] },
  { id: 'azul', hosts: ['api.azul.com'] },
  { id: 'spark', hosts: ['sparkapi.lucko.me', 'spark.lucko.me'] },
  /** Mode d'accès direct : le panel demande son certificat à Let's Encrypt. */
  { id: 'letsEncrypt', hosts: ['acme-v02.api.letsencrypt.org'] },
] as const satisfies readonly { id: string; hosts: readonly string[] }[];

export type ThirdPartyServiceId = (typeof SERVICES)[number]['id'];

export interface ThirdPartyService {
  id: ThirdPartyServiceId;
  hosts: readonly string[];
}

export const THIRD_PARTY_SERVICES: readonly ThirdPartyService[] = SERVICES;
