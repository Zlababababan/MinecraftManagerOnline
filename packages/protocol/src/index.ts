/**
 * @mmo/protocol — protocole panel↔agent (doc 05).
 *
 * Règles (appliquées par ESLint) : jamais `.strict()` sur un schéma — le protocole évolue par ajout,
 * et un pair N/N-1 doit ignorer les champs qu'il ne connaît pas.
 */
export * from './version.js';
export * from './errors.js';
export * from './common.js';
export * from './envelope.js';
export * from './catalog.js';
export * from './messages/agent.js';
export * from './messages/server.js';
export * from './messages/console.js';
export * from './messages/fs.js';
export * from './messages/monitoring.js';
export * from './messages/tasks.js';
export * from './messages/transfer.js';
export * from './messages/migration.js';
export * from './messages/java.js';
export * from './messages/update.js';
export * from './transfer/frame.js';
export * from './transfer/engine.js';
export * from './rpc/ulid.js';
export * from './rpc/idempotency.js';
export * from './rpc/peer.js';
