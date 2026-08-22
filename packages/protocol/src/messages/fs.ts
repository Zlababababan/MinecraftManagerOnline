/** Fichiers et configuration (doc 05 §6 « Fichiers et configuration », doc 06 §7). */
import { z } from 'zod';

import { epochMsSchema, serverIdSchema } from '../common.js';

/**
 * Chemin relatif, normalisé et jailé à la racine du serveur (`../` refusé par l'agent).
 * Séparateur `/` quel que soit l'OS.
 */
export const relativePathSchema = z
  .string()
  .refine((p) => !p.startsWith('/') && !/^[A-Za-z]:/.test(p) && !p.split(/[\\/]/).includes('..'), {
    message: 'relative path without ".." expected',
  });

export const fsPathSchema = z.object({ serverId: serverIdSchema, path: relativePathSchema });

export const fsEntryKindSchema = z.enum(['file', 'dir', 'symlink', 'other']);

export const fsEntrySchema = z.object({
  name: z.string(),
  kind: fsEntryKindSchema,
  size: z.int().nonnegative().optional(),
  modifiedAt: epochMsSchema.optional(),
});

export const fsListResponseSchema = z.object({ entries: z.array(fsEntrySchema) });

export const fsStatResponseSchema = z.object({
  kind: fsEntryKindSchema,
  size: z.int().nonnegative(),
  modifiedAt: epochMsSchema,
  createdAt: epochMsSchema.optional(),
});

export const fsMoveSchema = z.object({
  serverId: serverIdSchema,
  from: relativePathSchema,
  to: relativePathSchema,
  overwrite: z.boolean().optional(),
});

/** Suppression = corbeille `.mmo-trash/` (purge 7 j). */
export const fsDeleteResponseSchema = z.object({ trashedAs: z.string() });

export const fsReadSchema = fsPathSchema.extend({
  /** Inline ≤ 512 Ko ; au-delà, le panel bascule sur `fs.download` (jalon C). */
  maxBytes: z.int().positive().optional(),
});
export const fsReadResponseSchema = z.object({
  content: z.string(),
  encoding: z.literal('utf8'),
  sha256: z.string().length(64),
  size: z.int().nonnegative(),
  truncated: z.boolean(),
});

export const fsWriteSchema = fsPathSchema.extend({
  content: z.string(),
  /** `E_CONFLICT` si le fichier a changé entre-temps (édition concurrente). */
  expectedSha256: z.string().length(64).optional(),
});
export const fsWriteResponseSchema = z.object({ sha256: z.string().length(64) });

// --- Configuration typée ------------------------------------------------------------------------

export const configFileSchema = z.enum([
  'server.properties',
  'whitelist.json',
  'ops.json',
  'banned-players.json',
  'banned-ips.json',
]);
export type ConfigFile = z.infer<typeof configFileSchema>;

/** `server.properties` rendu en objet plat (clés inconnues préservées telles quelles). */
export const serverPropertiesDataSchema = z.record(z.string(), z.string());
/** Patch `server.properties` : clés présentes = écrites, `null` = supprimées. */
export const serverPropertiesPatchSchema = z.record(z.string(), z.string().nullable());

/** Entrées des fichiers JSON (doc 06 §7) — lecture tolérante, écriture complétée par l'agent. */
export const whitelistEntrySchema = z.object({ uuid: z.string(), name: z.string() });
export type WhitelistEntry = z.infer<typeof whitelistEntrySchema>;
export const opEntrySchema = whitelistEntrySchema.extend({
  level: z.int().min(1).max(4).optional(),
  bypassesPlayerLimit: z.boolean().optional(),
});
export type OpEntry = z.infer<typeof opEntrySchema>;
/** `expires` : `forever` ou `yyyy-MM-dd HH:mm:ss Z` (format Java du serveur). */
const banFieldsSchema = {
  created: z.string().optional(),
  source: z.string().optional(),
  expires: z.string().optional(),
  reason: z.string().optional(),
};
export const bannedPlayerEntrySchema = whitelistEntrySchema.extend(banFieldsSchema);
export type BannedPlayerEntry = z.infer<typeof bannedPlayerEntrySchema>;
export const bannedIpEntrySchema = z.object({ ip: z.string(), ...banFieldsSchema });
export type BannedIpEntry = z.infer<typeof bannedIpEntrySchema>;

export const CONFIG_DATA_SCHEMAS = {
  'server.properties': serverPropertiesDataSchema,
  'whitelist.json': z.array(whitelistEntrySchema),
  'ops.json': z.array(opEntrySchema),
  'banned-players.json': z.array(bannedPlayerEntrySchema),
  'banned-ips.json': z.array(bannedIpEntrySchema),
} as const;
export type ConfigData<F extends ConfigFile> = z.infer<(typeof CONFIG_DATA_SCHEMAS)[F]>;
/** Données acceptées par `config.set` (properties = patch, JSON = tableau complet). */
export const CONFIG_SET_SCHEMAS = {
  ...CONFIG_DATA_SCHEMAS,
  'server.properties': serverPropertiesPatchSchema,
} as const;
export type ConfigSetData<F extends ConfigFile> = z.infer<(typeof CONFIG_SET_SCHEMAS)[F]>;

export const configGetSchema = z.object({ serverId: serverIdSchema, file: configFileSchema });
export const configGetResponseSchema = z.object({
  file: configFileSchema,
  /** `server.properties` → objet clé/valeur (clés inconnues préservées) ; JSON → tableau structuré. */
  data: z.unknown(),
  sha256: z.string().length(64).optional(),
  /** `live` = obtenu via commandes (serveur en marche), `file` = lecture disque. */
  source: z.enum(['file', 'live']),
});

export const configSetSchema = z.object({
  serverId: serverIdSchema,
  file: configFileSchema,
  data: z.unknown(),
  expectedSha256: z.string().length(64).optional(),
});
export const configSetResponseSchema = z.object({
  /** Routage par l'agent : en marche → commandes ; arrêté → édition de fichier (doc 06 §7). */
  applied: z.enum(['file', 'commands']),
  restartRequired: z.boolean(),
  /** Commandes envoyées au serveur (mode `commands`), pour l'audit. */
  commands: z.array(z.string()).optional(),
  /** Codes d'avertissement (`W_*`, traduits par l'UI) : ex. niveau d'op non modifiable à chaud. */
  warnings: z.array(z.string()).optional(),
  sha256: z.string().length(64).optional(),
});

/** Avertissements possibles de `config.set` / `player.action` (l'UI traduit). */
export const CONFIG_WARNINGS = [
  'W_OP_LEVEL_LIVE',
  'W_BAN_EXPIRES_LIVE',
  'W_COMMAND_FAILED',
  'W_KICK_REQUIRES_RUNNING',
] as const;
export type ConfigWarning = (typeof CONFIG_WARNINGS)[number];
