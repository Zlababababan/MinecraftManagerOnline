/**
 * Proxy Velocity (doc 06 §1) : un serveur Java ordinaire lancé par le template `jar`, mais sans
 * `server.properties`, sans version Minecraft et sans EULA Mojang. Sa configuration vit dans
 * `velocity.toml` — on n'en lit que le strict utile (port d'écoute, MOTD), sans parseur TOML.
 */

/** Velocity 3.x exige Java 17+ (indépendant de toute version Minecraft). */
export const VELOCITY_JAVA_MAJOR = 17;

/** Port d'écoute par défaut d'un Velocity fraîchement extrait. */
export const VELOCITY_DEFAULT_PORT = 25_577;

export interface VelocityToml {
  /** Port de `bind = "0.0.0.0:25577"` (absent si la ligne manque ou est illisible). */
  port?: number;
  /** MOTD brut (souvent du MiniMessage, affiché tel quel). */
  motd?: string;
}

export function parseVelocityToml(text: string): VelocityToml {
  const out: VelocityToml = {};
  const bind = /^\s*bind\s*=\s*"[^"]*?:(\d{1,5})"/m.exec(text);
  if (bind?.[1] !== undefined) {
    const port = Number(bind[1]);
    if (port >= 1 && port <= 65_535) out.port = port;
  }
  const motd = /^\s*motd\s*=\s*"([^"\n]*)"/m.exec(text);
  if (motd?.[1] !== undefined && motd[1] !== '') out.motd = motd[1];
  return out;
}
