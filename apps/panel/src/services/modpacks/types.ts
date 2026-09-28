/**
 * Fournisseurs de modpacks (lot 5). Un fournisseur traduit une référence (`packId`, `versionId`) en
 * ce que l'installation sait faire : une étape `fetchMany` (les fichiers du pack) suivie du plan
 * ordinaire de son chargeur. `InstallsService` ne connaît que cette interface — c'est ce qui rend
 * chaque fournisseur retirable (docs/services-tiers.md).
 */
import type { InstallStep } from '@mmo/protocol';
import type { InstallLoader, ModpackRef } from '@mmo/protocol/client';

export interface ModpackResolution {
  /** Nom lisible (« FTB Evolution 1.43.1 »), pour le journal et la progression. */
  label: string;
  loader: InstallLoader;
  mcVersion: string;
  /** Build de chargeur IMPOSÉ par le pack (jamais le « recommandé » du panel). */
  loaderVersion: string | undefined;
  /** Étape qui pose les fichiers du pack, avant l'installeur du chargeur. */
  files: Extract<InstallStep, { kind: 'fetchMany' }>;
}

export interface ModpackProvider {
  resolve(ref: ModpackRef): Promise<ModpackResolution>;
}
