/**
 * Espace libre d'un volume (`fs.statfs`), sondé sur le chemin demandé puis sur ses parents tant
 * qu'il n'existe pas encore — une destination de sauvegarde ou un dossier cible de migration
 * peuvent être créés à la volée. `undefined` = impossible à mesurer (plateforme ou volume qui ne
 * répond pas) : l'appelant décide alors sans garde, il ne devine pas.
 */
import { statfs } from 'node:fs/promises';
import path from 'node:path';

export async function freeBytes(target: string): Promise<number | undefined> {
  let probe = target;
  for (let i = 0; i < 8; i++) {
    try {
      const fsStat = await statfs(probe);
      return fsStat.bavail * fsStat.bsize;
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return undefined;
      probe = parent;
    }
  }
  return undefined;
}
