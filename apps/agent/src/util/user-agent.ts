/**
 * Identité de l'agent auprès des services tiers (Mojang, CDN de mods, catalogues) : un client
 * identifiable, avec une adresse de contact, plutôt qu'un « bot » anonyme (docs/services-tiers.md).
 * Sans version : `AGENT_VERSION` vit dans `agent.ts`, que les utilitaires n'importent pas.
 */
export const AGENT_USER_AGENT =
  'MinecraftManagerOnline-agent (+https://github.com/Zlababababan/MinecraftManagerOnline)';
