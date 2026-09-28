/**
 * Intégration FTB (lot 5, doc 06 §6quinquies) — **retirable en entier** : ce fichier, ses
 * homologues du panel, de `@mmo/shared` et du front sont listés dans `docs/services-tiers.md`.
 * Le reste du produit n'en dépend pas (l'étape `fetchMany` du protocole est générique).
 */
import { z } from 'zod';

import { epochMsSchema } from '../common.js';

export const FTB_SEARCH_LIMIT = 20;

export const ftbPackSummaryDtoSchema = z.object({
  id: z.int(),
  name: z.string(),
  synopsis: z.string(),
});
export type FtbPackSummaryDto = z.infer<typeof ftbPackSummaryDtoSchema>;

export const ftbPackListDtoSchema = z.object({ packs: z.array(ftbPackSummaryDtoSchema) });
export type FtbPackListDto = z.infer<typeof ftbPackListDtoSchema>;

export const ftbVersionDtoSchema = z.object({
  id: z.int(),
  name: z.string(),
  type: z.string(),
  releasedAt: epochMsSchema.optional(),
  mcVersion: z.string().nullable(),
  loader: z.enum(['forge', 'neoforge', 'fabric']).nullable(),
  loaderVersion: z.string().nullable(),
  ramRecommendedMb: z.int().nullable(),
  /** Le panel sait-il l'installer ? (chargeur connu, version de jeu connue.) */
  installable: z.boolean(),
});
export type FtbVersionDto = z.infer<typeof ftbVersionDtoSchema>;

export const ftbPackDtoSchema = ftbPackSummaryDtoSchema.extend({
  versions: z.array(ftbVersionDtoSchema),
});
export type FtbPackDto = z.infer<typeof ftbPackDtoSchema>;
