/**
 * Lot 4 — deux gardes AVANT d'écrire une archive (doc 05 §6, doc 06 §4).
 *
 * 1. **Espace disque.** Un disque plein produisait une archive tronquée, un manifeste jamais
 *    écrit et une task en échec tardif après des minutes de compression. On estime d'abord la
 *    taille de l'archive : octets bruts × taux de compression **mesuré sur la dernière archive du
 *    même serveur** (les mondes Minecraft sont déjà compressés par région, un taux générique
 *    mentirait), sans historique 1:1 (l'hypothèse pessimiste, pour la première sauvegarde), plus
 *    une marge fixe — le serveur qui partage le disque doit pouvoir continuer d'écrire.
 *
 * 2. **Marqueur de destination.** Le pire scénario est silencieux : un `/mnt/nas` non monté est un
 *    dossier vide sur le disque système, où tout s'écrit sans erreur jusqu'au jour où l'on cherche
 *    les sauvegardes. L'agent dépose un fichier marqueur à la racine d'une destination **explicite**
 *    quand elle est configurée (une fois, à ce moment-là — jamais rejoué à chaque connexion, sinon
 *    la garde se réarmerait toute seule sur le mauvais disque), et refuse d'écrire s'il manque.
 *    La destination par défaut (`<stateDir>/backups`) n'en a pas besoin : c'est le dossier de
 *    l'agent lui-même.
 */
import { mkdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Nom du marqueur, à la racine de la destination (pas dans le sous-dossier du serveur). */
export const DESTINATION_MARKER = '.mmo-backups.json';

/** Marge ajoutée à l'estimation : manifeste, métadonnées, et de l'air pour le serveur voisin. */
export const SPACE_HEADROOM_BYTES = 64 * 1024 * 1024;

/** Taux de compression retenu quand l'historique en donne un aberrant (archive vide, manifeste forgé). */
const RATIO_MIN = 0.05;

export interface ArchiveEstimate {
  /** Octets à prévoir sur la destination, marge comprise. */
  requiredBytes: number;
  /** Taux appliqué (`sizeBytes / bytesRaw` de l'archive de référence, ou 1 sans historique). */
  ratio: number;
  /** `backupId` de l'archive qui a fourni le taux, s'il y en a une. */
  basedOn: string | undefined;
}

/**
 * Estime la taille de l'archive à venir. `history` = manifestes connus du serveur, dans n'importe
 * quel ordre : c'est le **plus récent** exploitable (`bytesRaw > 0`) qui donne le taux. Le taux est
 * plafonné à 1 (une archive n'est jamais comptée plus grosse que ses sources) et planché à
 * `RATIO_MIN`.
 */
export function estimateArchiveBytes(
  bytesRaw: number,
  history: readonly { backupId: string; createdAt: number; bytesRaw: number; sizeBytes: number }[],
): ArchiveEstimate {
  const reference = history
    .filter((m) => m.bytesRaw > 0 && m.sizeBytes >= 0)
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  const ratio =
    reference === undefined
      ? 1
      : Math.min(1, Math.max(RATIO_MIN, reference.sizeBytes / reference.bytesRaw));
  return {
    requiredBytes: Math.ceil(bytesRaw * ratio) + SPACE_HEADROOM_BYTES,
    ratio,
    basedOn: reference?.backupId,
  };
}

export function markerPath(destinationRoot: string): string {
  return path.join(destinationRoot, DESTINATION_MARKER);
}

/** Le marqueur est présent (n'importe quel contenu : un fichier vide créé à la main compte). */
export async function hasMarker(destinationRoot: string): Promise<boolean> {
  try {
    return (await stat(markerPath(destinationRoot))).isFile();
  } catch {
    return false;
  }
}

/**
 * Dépose le marqueur s'il manque (dossier créé au besoin). Rend `true` s'il a été écrit, `false`
 * s'il existait déjà — un marqueur posé par une autre machine du parc, ou à la main, est conservé.
 */
export async function writeMarker(
  destinationRoot: string,
  info: { agentVersion: string; now: number },
): Promise<boolean> {
  if (await hasMarker(destinationRoot)) return false;
  await mkdir(destinationRoot, { recursive: true });
  const body = {
    purpose: 'backup destination marker for the MinecraftManagerOnline agent',
    note: 'If this file is missing at backup time, the agent refuses to write here (folder not mounted?).',
    createdAt: new Date(info.now).toISOString(),
    agentVersion: info.agentVersion,
    hostname: os.hostname(),
  };
  await writeFile(markerPath(destinationRoot), JSON.stringify(body, null, 2) + '\n', {
    flag: 'wx',
  }).catch((error: unknown) => {
    // Course avec un autre agent du parc sur la même destination : le marqueur est là, c'est
    // tout ce qui compte.
    if ((error as { code?: string }).code === 'EEXIST') return;
    throw error;
  });
  return true;
}
