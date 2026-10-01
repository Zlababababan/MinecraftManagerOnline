/**
 * Lot 5 — serveur depuis une archive (doc 06 §6sexies). Un « server pack » fourni en zip dit son
 * chargeur dans ses scripts de démarrage : on LIT ces scripts, on ne les exécute jamais (boucle de
 * redémarrage, `pause`, téléchargement par `bitsadmin` — mesuré sur ATM10 Aero 0.7.1).
 *
 * Mesuré : `NEOFORGE_VERSION=21.1.250` (`.sh`) / `set NEOFORGE_VERSION=21.1.250` (`.bat`), et un
 * `server.properties` par défaut écrit par le script. **Non mesuré** (écrit d'après la même forme,
 * à vérifier sur un vrai zip) : `FORGE_VERSION=` des packs plus anciens.
 */
import { mcVersionFromNeoForge } from '../detection/detect.js';

export interface ArchiveHints {
  loader: 'forge' | 'neoforge';
  mcVersion: string;
  loaderVersion: string;
  /** Script où le chargeur a été lu (affiché à l'utilisateur). */
  source: string;
}

/** Clés que le panel gère lui-même : jamais reprises d'un script. */
const MANAGED_PROPERTY = /^(server-port|server-ip|query\.port|enable-rcon|enable-query|rcon\..*)$/;
const PROPERTY_LINE = /^([a-z][a-z0-9.-]{0,63})=(.{0,200})$/;
const MAX_ARCHIVE_PROPERTIES = 32;

const variable = (text: string, name: string): string | undefined =>
  new RegExp(`^[ \\t]*(?:set[ \\t]+|export[ \\t]+)?${name}=["']?([\\w.+-]+)`, 'im').exec(text)?.[1];

/** Chargeur, version de jeu et build déclarés par les scripts de l'archive ; `undefined` sinon. */
export function readArchiveHints(
  texts: readonly { name: string; content: string }[],
): ArchiveHints | undefined {
  for (const { name, content } of texts) {
    const neo = variable(content, 'NEOFORGE_VERSION');
    if (neo !== undefined) {
      const mcVersion = mcVersionFromNeoForge(neo);
      if (mcVersion !== undefined) {
        return { loader: 'neoforge', mcVersion, loaderVersion: neo, source: name };
      }
    }
    const forge = variable(content, 'FORGE_VERSION');
    if (forge !== undefined) {
      // `1.20.1-47.3.0` dit tout ; sinon la version de jeu est dans une variable ou dans le nom
      // de l'installeur (`forge-1.20.1-$FORGE_VERSION-installer.jar`).
      const full = /^(1\.\d+(?:\.\d+)?)-(.+)$/.exec(forge);
      const mcVersion =
        full?.[1] ??
        variable(content, 'MINECRAFT_VERSION') ??
        variable(content, 'MC_VERSION') ??
        /forge-(1\.\d+(?:\.\d+)?)-/i.exec(content)?.[1];
      if (mcVersion !== undefined) {
        return { loader: 'forge', mcVersion, loaderVersion: full?.[2] ?? forge, source: name };
      }
    }
  }
  return undefined;
}

/**
 * `server.properties` par défaut qu'un script écrirait au premier lancement : `printf "a=1\nb=2"
 * > server.properties` (sh) ou un bloc de `echo a=1` redirigé vers le fichier (bat).
 */
export function readArchiveProperties(
  texts: readonly { name: string; content: string }[],
): Record<string, string> {
  const values: Record<string, string> = {};
  const add = (line: string): void => {
    const m = PROPERTY_LINE.exec(line.trim());
    if (m?.[1] === undefined || m[2] === undefined || MANAGED_PROPERTY.test(m[1])) return;
    if (Object.keys(values).length < MAX_ARCHIVE_PROPERTIES) values[m[1]] ??= m[2].trim();
  };
  for (const { content } of texts) {
    const printf = /printf\s+"([^"]{1,4000})"\s*>\s*"?server\.properties/.exec(content)?.[1];
    if (printf !== undefined) {
      for (const line of printf.split('\\n')) add(line);
    }
    const block = /\(((?:\s*echo [^\r\n]*\r?\n)+)\s*\)\s*>\s*"?server\.properties/i.exec(
      content,
    )?.[1];
    if (block !== undefined) {
      for (const line of block.split(/\r?\n/)) add(line.replace(/^\s*echo /i, ''));
    }
    if (Object.keys(values).length > 0) break;
  }
  return values;
}
