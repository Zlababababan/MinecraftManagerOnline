/**
 * Catalogue des messages du jalon A (doc 05 §6) : requêtes (avec direction, schéma de requête et
 * de réponse) et événements. Les jalons B (tasks) et C (transferts) s'ajoutent ici sans bump de
 * version — le protocole n'évolue que par ajout.
 */
import type { z } from 'zod';

import { emptyPayloadSchema } from './common.js';
import {
  agentConfigureResponseSchema,
  agentConfigureSchema,
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
  playerEventSchema,
  playerListResponseSchema,
  serverCommandResponseSchema,
  serverCommandSchema,
  serverDetectedSchema,
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

/** Direction : `p2a` = panel → agent, `a2p` = agent → panel. */
export type Direction = 'p2a' | 'a2p';

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
  // Contrôle des serveurs
  'server.start': req('p2a', serverRefSchema, serverStartResponseSchema),
  'server.stop': req('p2a', serverStopSchema, serverStopResponseSchema),
  'server.restart': req('p2a', serverRestartSchema, emptyPayloadSchema),
  'server.kill': req('p2a', serverRefSchema, serverKillResponseSchema),
  'server.command': req('p2a', serverCommandSchema, serverCommandResponseSchema),
  'server.rcon': req('p2a', serverRconSchema, serverRconResponseSchema),
  'server.eulaAccept': req('p2a', serverRefSchema, emptyPayloadSchema),
  'server.setProvisioning': req('p2a', serverSetProvisioningSchema, emptyPayloadSchema),
  'player.list': req('p2a', serverRefSchema, playerListResponseSchema),
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

/** Rôle d'un pair ; détermine les types qu'il peut émettre. */
export type Role = 'panel' | 'agent';
type DirFor<R extends Role> = R extends 'panel' ? 'p2a' : 'a2p';

export type RequestTypesFrom<R extends Role> = {
  [T in RequestType]: (typeof REQUESTS)[T]['dir'] extends DirFor<R> ? T : never;
}[RequestType];
export type EventTypesFrom<R extends Role> = {
  [T in EventType]: (typeof EVENTS)[T]['dir'] extends DirFor<R> ? T : never;
}[EventType];

export function isRequestType(type: string): type is RequestType {
  return Object.hasOwn(REQUESTS, type);
}
export function isEventType(type: string): type is EventType {
  return Object.hasOwn(EVENTS, type);
}

export const REQUEST_TYPES = Object.keys(REQUESTS) as RequestType[];
export const EVENT_TYPES = Object.keys(EVENTS) as EventType[];
