/**
 * Catalogue des messages (doc 05 §6) : requêtes (avec direction, schéma de requête et de réponse)
 * et événements. Jalon A (phase 2), puis jalons B (tasks, backups) et C (transferts binaires) en
 * phase 8 — ajoutés sans bump de version, le protocole n'évolue que par ajout. Les messages de
 * contrôle des transferts sont bidirectionnels (`both`) : chaque pair peut être émetteur ou récepteur.
 * Phase 9 (sans bump) : migration agent → agent, `java.install/remove`, `agent.update` /
 * `runtime.update` + `agent.updateResult`.
 */
import type { z } from 'zod';

import { emptyPayloadSchema } from './common.js';
import {
  agentConfigureResponseSchema,
  agentConfigureSchema,
  agentDiagnosticsResponseSchema,
  agentDiagnosticsSchema,
  agentHeartbeatSchema,
  agentInfoResponseSchema,
  agentLogSchema,
  agentRestartResponseSchema,
  agentRestartSchema,
  agentRotateSecretSchema,
  authHelloSchema,
  authOkSchema,
  pairRequestSchema,
  pairResponseSchema,
  syncStateSchema,
} from './messages/agent.js';
import {
  consoleLinesSchema,
  consoleSubscribeResponseSchema,
  consoleSubscribeSchema,
  logsListFilesResponseSchema,
  logsSearchResponseSchema,
  logsSearchSchema,
} from './messages/console.js';
import {
  configGetResponseSchema,
  configGetSchema,
  configSetResponseSchema,
  configSetSchema,
  fsDeleteResponseSchema,
  fsListResponseSchema,
  fsMoveSchema,
  fsPathSchema,
  fsReadResponseSchema,
  fsReadSchema,
  fsStatResponseSchema,
  fsWriteResponseSchema,
  fsWriteSchema,
} from './messages/fs.js';
import {
  eventAckSchema,
  javaListResponseSchema,
  metricsConfigureSchema,
  metricsSampleSchema,
  portConflictSchema,
  watchdogAlertSchema,
} from './messages/monitoring.js';
import {
  playerActionResponseSchema,
  playerActionSchema,
  playerEventSchema,
  playerListResponseSchema,
  playerResolveResponseSchema,
  playerResolveSchema,
  scanRunResponseSchema,
  scanRunSchema,
  serverCommandResponseSchema,
  serverCommandSchema,
  serverDetectedSchema,
  serverCommandHelpResponseSchema,
  serverCommandHelpSchema,
  serverKillResponseSchema,
  serverRconResponseSchema,
  serverRconSchema,
  serverRefSchema,
  serverRemovedSchema,
  serverRestartSchema,
  serverSetProvisioningSchema,
  serverStartResponseSchema,
  serverStateChangedSchema,
  serverStopResponseSchema,
  serverStopSchema,
  serverUpdatedSchema,
} from './messages/server.js';
import {
  backupBrowseResponseSchema,
  backupBrowseSchema,
  backupCreateResponseSchema,
  backupCreateSchema,
  backupDeleteResponseSchema,
  backupDeleteSchema,
  backupListResponseSchema,
  backupListSchema,
  backupRestorePathsSchema,
  backupReceiveSchema,
  backupRestoreSchema,
  backupRotatedSchema,
  backupSkippedSchema,
  backupVerifiedSchema,
  fsFetchSchema,
  taskAcceptedSchema,
  taskAckResultSchema,
  taskCancelResponseSchema,
  taskCancelSchema,
  taskCompletedSchema,
  taskFailedSchema,
  taskListResponseSchema,
  taskProgressSchema,
} from './messages/tasks.js';
import { javaInstallSchema, javaRemoveResponseSchema, javaRemoveSchema } from './messages/java.js';
import {
  migrationExportSchema,
  migrationFinalizeResponseSchema,
  migrationFinalizeSchema,
  migrationImportSchema,
  migrationPrecheckResponseSchema,
  migrationPrecheckSchema,
  transferServeResponseSchema,
  transferServeSchema,
} from './messages/migration.js';
import {
  agentUpdateResponseSchema,
  agentUpdateResultSchema,
  agentUpdateSchema,
  runtimeUpdateResponseSchema,
  runtimeUpdateSchema,
} from './messages/update.js';
import {
  fsDownloadStartResponseSchema,
  fsDownloadStartSchema,
  fsTransferAckSchema,
  fsTransferCancelSchema,
  fsTransferDoneResponseSchema,
  fsTransferDoneSchema,
  fsUploadStartResponseSchema,
  fsUploadStartSchema,
} from './messages/transfer.js';

/** Direction : `p2a` = panel → agent, `a2p` = agent → panel, `both` = les deux (transferts). */
export type Direction = 'p2a' | 'a2p' | 'both';

export interface RequestDefinition {
  readonly dir: Direction;
  readonly request: z.ZodType;
  readonly response: z.ZodType;
}
export interface EventDefinition {
  readonly dir: Direction;
  readonly payload: z.ZodType;
  /** Événement critique : porte un `eventId`, journalisé par l'agent et rejoué jusqu'à `event.ack`. */
  readonly critical?: boolean;
}

function req<D extends Direction, Req extends z.ZodType, Res extends z.ZodType>(
  dir: D,
  request: Req,
  response: Res,
) {
  return { dir, request, response } as const;
}
function evt<D extends Direction, P extends z.ZodType>(dir: D, payload: P, critical = false) {
  return { dir, payload, critical } as const;
}

export const REQUESTS = {
  // Cycle de vie agent
  'pair.request': req('a2p', pairRequestSchema, pairResponseSchema),
  'auth.hello': req('a2p', authHelloSchema, authOkSchema),
  'sync.state': req('a2p', syncStateSchema, emptyPayloadSchema),
  'agent.info': req('p2a', emptyPayloadSchema, agentInfoResponseSchema),
  'agent.configure': req('p2a', agentConfigureSchema, agentConfigureResponseSchema),
  'agent.rotateSecret': req('p2a', agentRotateSecretSchema, emptyPayloadSchema),
  'agent.restart': req('p2a', agentRestartSchema, agentRestartResponseSchema),
  /** Lot 9 (sans bump) : diagnostic borné (état de l'agent + fin de son journal fichier). */
  'agent.diagnostics': req('p2a', agentDiagnosticsSchema, agentDiagnosticsResponseSchema),
  // Détection
  'scan.run': req('p2a', scanRunSchema, scanRunResponseSchema),
  // Contrôle des serveurs
  'server.start': req('p2a', serverRefSchema, serverStartResponseSchema),
  'server.stop': req('p2a', serverStopSchema, serverStopResponseSchema),
  'server.restart': req('p2a', serverRestartSchema, emptyPayloadSchema),
  'server.kill': req('p2a', serverRefSchema, serverKillResponseSchema),
  'server.command': req('p2a', serverCommandSchema, serverCommandResponseSchema),
  'server.rcon': req('p2a', serverRconSchema, serverRconResponseSchema),
  'server.commandHelp': req('p2a', serverCommandHelpSchema, serverCommandHelpResponseSchema),
  'server.eulaAccept': req('p2a', serverRefSchema, emptyPayloadSchema),
  'server.setProvisioning': req('p2a', serverSetProvisioningSchema, emptyPayloadSchema),
  'player.list': req('p2a', serverRefSchema, playerListResponseSchema),
  'player.action': req('p2a', playerActionSchema, playerActionResponseSchema),
  'player.resolve': req('p2a', playerResolveSchema, playerResolveResponseSchema),
  // Console et logs
  'console.subscribe': req('p2a', consoleSubscribeSchema, consoleSubscribeResponseSchema),
  'console.unsubscribe': req('p2a', serverRefSchema, emptyPayloadSchema),
  'logs.search': req('p2a', logsSearchSchema, logsSearchResponseSchema),
  'logs.listFiles': req('p2a', serverRefSchema, logsListFilesResponseSchema),
  // Fichiers et configuration
  'fs.list': req('p2a', fsPathSchema, fsListResponseSchema),
  'fs.stat': req('p2a', fsPathSchema, fsStatResponseSchema),
  'fs.mkdir': req('p2a', fsPathSchema, emptyPayloadSchema),
  'fs.rename': req('p2a', fsMoveSchema, emptyPayloadSchema),
  'fs.copy': req('p2a', fsMoveSchema, emptyPayloadSchema),
  'fs.delete': req('p2a', fsPathSchema, fsDeleteResponseSchema),
  'fs.read': req('p2a', fsReadSchema, fsReadResponseSchema),
  'fs.write': req('p2a', fsWriteSchema, fsWriteResponseSchema),
  'config.get': req('p2a', configGetSchema, configGetResponseSchema),
  'config.set': req('p2a', configSetSchema, configSetResponseSchema),
  // Monitoring et Java
  'metrics.configure': req('p2a', metricsConfigureSchema, emptyPayloadSchema),
  'java.list': req('p2a', emptyPayloadSchema, javaListResponseSchema),
  // Événements fiables
  'event.ack': req('p2a', eventAckSchema, emptyPayloadSchema),
  // Jalon B — tasks et backups (phase 8)
  'task.cancel': req('p2a', taskCancelSchema, taskCancelResponseSchema),
  'task.ackResult': req('p2a', taskAckResultSchema, emptyPayloadSchema),
  'task.list': req('p2a', emptyPayloadSchema, taskListResponseSchema),
  'backup.create': req('p2a', backupCreateSchema, backupCreateResponseSchema),
  'backup.list': req('p2a', backupListSchema, backupListResponseSchema),
  'backup.restore': req('p2a', backupRestoreSchema, taskAcceptedSchema),
  'backup.delete': req('p2a', backupDeleteSchema, backupDeleteResponseSchema),
  // Lot 4 — restauration partielle (ajout sans bump : un agent N-1 répond E_UNSUPPORTED_TYPE)
  'backup.browse': req('p2a', backupBrowseSchema, backupBrowseResponseSchema),
  'backup.restorePaths': req('p2a', backupRestorePathsSchema, taskAcceptedSchema),
  // Lot 4 — réplication hors-site (ajout sans bump, capacité `replication`)
  'backup.receive': req('p2a', backupReceiveSchema, taskAcceptedSchema),
  'fs.fetch': req('p2a', fsFetchSchema, taskAcceptedSchema),
  // Jalon C — transferts binaires (phase 8)
  'fs.download.start': req('p2a', fsDownloadStartSchema, fsDownloadStartResponseSchema),
  'fs.upload.start': req('p2a', fsUploadStartSchema, fsUploadStartResponseSchema),
  'fs.transfer.done': req('both', fsTransferDoneSchema, fsTransferDoneResponseSchema),
  // Phase 9 — migration agent → agent
  'migration.export': req('p2a', migrationExportSchema, taskAcceptedSchema),
  'transfer.serve': req('p2a', transferServeSchema, transferServeResponseSchema),
  'migration.precheck': req('p2a', migrationPrecheckSchema, migrationPrecheckResponseSchema),
  'migration.import': req('p2a', migrationImportSchema, taskAcceptedSchema),
  'migration.finalize': req('p2a', migrationFinalizeSchema, migrationFinalizeResponseSchema),
  // Phase 9 — Java géré
  'java.install': req('p2a', javaInstallSchema, taskAcceptedSchema),
  'java.remove': req('p2a', javaRemoveSchema, javaRemoveResponseSchema),
  // Phase 9 — mises à jour
  'agent.update': req('p2a', agentUpdateSchema, agentUpdateResponseSchema),
  'runtime.update': req('p2a', runtimeUpdateSchema, runtimeUpdateResponseSchema),
} as const satisfies Record<string, RequestDefinition>;

export const EVENTS = {
  'agent.heartbeat': evt('a2p', agentHeartbeatSchema),
  'agent.log': evt('a2p', agentLogSchema),
  'server.detected': evt('a2p', serverDetectedSchema, true),
  'server.removed': evt('a2p', serverRemovedSchema, true),
  'server.updated': evt('a2p', serverUpdatedSchema, true),
  'server.stateChanged': evt('a2p', serverStateChangedSchema, true),
  'player.event': evt('a2p', playerEventSchema, true),
  'console.lines': evt('a2p', consoleLinesSchema),
  'metrics.sample': evt('a2p', metricsSampleSchema),
  'watchdog.alert': evt('a2p', watchdogAlertSchema, true),
  'port.conflict': evt('a2p', portConflictSchema),
  // Jalon B
  'task.progress': evt('a2p', taskProgressSchema),
  'task.completed': evt('a2p', taskCompletedSchema, true),
  'task.failed': evt('a2p', taskFailedSchema, true),
  'backup.rotated': evt('a2p', backupRotatedSchema, true),
  // Non critique : voir le commentaire du schéma (un panel N-1 le jette sans acquitter).
  'backup.skipped': evt('a2p', backupSkippedSchema),
  // Lot 4 — non critique aussi : le manifeste porte le résultat, `backup.list` le rattrape.
  'backup.verified': evt('a2p', backupVerifiedSchema),
  // Jalon C
  'fs.transfer.ack': evt('both', fsTransferAckSchema),
  'fs.transfer.cancel': evt('both', fsTransferCancelSchema),
  // Phase 9
  'agent.updateResult': evt('a2p', agentUpdateResultSchema, true),
} as const satisfies Record<string, EventDefinition>;

export type RequestType = keyof typeof REQUESTS;
export type EventType = keyof typeof EVENTS;
export type MessageType = RequestType | EventType;

export type RequestPayload<T extends RequestType> = z.input<(typeof REQUESTS)[T]['request']>;
export type ParsedRequestPayload<T extends RequestType> = z.output<(typeof REQUESTS)[T]['request']>;
export type ResponsePayload<T extends RequestType> = z.input<(typeof REQUESTS)[T]['response']>;
export type ParsedResponsePayload<T extends RequestType> = z.output<
  (typeof REQUESTS)[T]['response']
>;
export type EventPayload<T extends EventType> = z.input<(typeof EVENTS)[T]['payload']>;
export type ParsedEventPayload<T extends EventType> = z.output<(typeof EVENTS)[T]['payload']>;

/** Rôle d'un pair ; détermine les types qu'il peut émettre et ceux qu'il reçoit. */
export type Role = 'panel' | 'agent';
type DirFor<R extends Role> = R extends 'panel' ? 'p2a' : 'a2p';
type DirTo<R extends Role> = R extends 'panel' ? 'a2p' : 'p2a';

/** Types qu'un pair de rôle `R` peut émettre (`both` inclus). */
export type RequestTypesFrom<R extends Role> = {
  [T in RequestType]: (typeof REQUESTS)[T]['dir'] extends DirFor<R> | 'both' ? T : never;
}[RequestType];
export type EventTypesFrom<R extends Role> = {
  [T in EventType]: (typeof EVENTS)[T]['dir'] extends DirFor<R> | 'both' ? T : never;
}[EventType];
/** Types qu'un pair de rôle `R` reçoit (donc traite via `handle`/`on`). */
export type RequestTypesTo<R extends Role> = {
  [T in RequestType]: (typeof REQUESTS)[T]['dir'] extends DirTo<R> | 'both' ? T : never;
}[RequestType];
export type EventTypesTo<R extends Role> = {
  [T in EventType]: (typeof EVENTS)[T]['dir'] extends DirTo<R> | 'both' ? T : never;
}[EventType];

export function isRequestType(type: string): type is RequestType {
  return Object.hasOwn(REQUESTS, type);
}
export function isEventType(type: string): type is EventType {
  return Object.hasOwn(EVENTS, type);
}

export const REQUEST_TYPES = Object.keys(REQUESTS) as RequestType[];
export const EVENT_TYPES = Object.keys(EVENTS) as EventType[];
