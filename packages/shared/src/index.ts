/**
 * @mmo/shared — code commun panel/agent/front (doc 03 §1) : i18n fr/en, mapping MC→Java, parsing
 * de logs, heuristiques de détection. Ce point d'entrée n'importe aucun module Node ; l'adaptateur
 * système de fichiers vit dans `@mmo/shared/node`.
 */
export const PROJECT_NAME = 'MinecraftManagerOnline';

export * from './i18n/index.js';
export * from './minecraft/version.js';
export * from './minecraft/tps.js';
export * from './java/index.js';
export * from './logs/parser.js';
export * from './logs/patterns.js';
export * from './detection/fs.js';
export * from './detection/detect.js';
export * from './detection/scan.js';
export * from './cron.js';
