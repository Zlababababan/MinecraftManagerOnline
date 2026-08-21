/**
 * Pair RPC typé, indépendant du transport (WebSocket côté panel/agent, mémoire en test).
 *
 * - `request(type, payload)` : émet un `req`, résout la réponse validée ou rejette `ProtocolError`
 *   (`E_TIMEOUT` au `deadlineMs`, `E_INTERRUPTED` si le transport se ferme).
 * - `handle(type, fn)` : enregistre un handler de requête ; payload validé en amont
 *   (`E_INVALID_PAYLOAD`), type inconnu → `E_UNSUPPORTED_TYPE` (jamais de déconnexion, doc 05 §11),
 *   réponse validée en aval, idempotence par `id` (cache 10 min / 1 000 entrées).
 * - `emit(type, payload)` / `on(type, fn)` : événements sans réponse.
 *
 * Les champs inconnus sont ignorés (jamais `.strict()`), condition de la compatibilité N/N-1.
 */
import type { z } from 'zod';

import {
  EVENTS,
  REQUESTS,
  isEventType,
  isRequestType,
  type EventPayload,
  type EventType,
  type EventTypesFrom,
  type ParsedEventPayload,
  type ParsedRequestPayload,
  type ParsedResponsePayload,
  type RequestPayload,
  type RequestType,
  type RequestTypesFrom,
  type ResponsePayload,
  type Role,
} from '../catalog.js';
import {
  envelopeSchema,
  type EventEnvelope,
  type RequestEnvelope,
  type ResponseEnvelope,
} from '../envelope.js';
import { ProtocolError, isProtocolError } from '../errors.js';
import { PROTOCOL_VERSION } from '../version.js';
import { IdempotencyCache, type IdempotencyCacheOptions } from './idempotency.js';
import { ulid } from './ulid.js';

/** Transport texte minimal (les frames binaires du jalon C passent à côté). */
export interface RpcTransport {
  send(data: string): void;
  onMessage(handler: (data: string) => void): void;
  onClose(handler: (reason?: string) => void): void;
}

export interface RequestContext {
  id: string;
  type: RequestType;
  ts: number;
  userId: string | undefined;
  deadlineMs: number | undefined;
}

export interface EventContext {
  type: EventType;
  ts: number;
  /** `id` d'enveloppe des événements critiques, à acquitter via `event.ack`. */
  id: string | undefined;
}

export type RequestHandler<T extends RequestType> = (
  payload: ParsedRequestPayload<T>,
  ctx: RequestContext,
) => ResponsePayload<T> | Promise<ResponsePayload<T>>;

export type EventHandler<T extends EventType> = (
  payload: ParsedEventPayload<T>,
  ctx: EventContext,
) => void | Promise<void>;

export interface RpcLogger {
  warn(message: string, context?: Record<string, unknown>): void;
}

export interface RpcPeerOptions {
  role: Role;
  transport: RpcTransport;
  /** Version négociée, inscrite dans `v` des messages sortants. */
  version?: number;
  /** Délai par défaut des requêtes (doc 05 §13 : 30 s). */
  defaultDeadlineMs?: number;
  now?: () => number;
  idempotency?: IdempotencyCacheOptions;
  logger?: RpcLogger;
  /** Identifiant d'utilisateur joint aux requêtes (panel). */
  userIdProvider?: () => string | undefined;
}

export interface RequestOptions {
  deadlineMs?: number;
  /** Rejeu d'une requête précédente avec le même `id` (dédupliquée côté récepteur). */
  id?: string;
  userId?: string;
}

interface Pending {
  type: RequestType;
  resolve: (value: unknown) => void;
  reject: (error: ProtocolError) => void;
  timer: ReturnType<typeof setTimeout>;
}

const noopLogger: RpcLogger = { warn: () => undefined };

export class RpcPeer<R extends Role = Role> {
  readonly role: R;
  private readonly transport: RpcTransport;
  private readonly now: () => number;
  private readonly defaultDeadlineMs: number;
  private readonly logger: RpcLogger;
  private readonly userIdProvider: (() => string | undefined) | undefined;
  private readonly pending = new Map<string, Pending>();
  private readonly requestHandlers = new Map<RequestType, RequestHandler<RequestType>>();
  private readonly eventHandlers = new Map<EventType, Set<EventHandler<EventType>>>();
  private readonly responses: IdempotencyCache<ResponseEnvelope>;
  private readonly inFlight = new Map<string, Promise<ResponseEnvelope>>();
  private closed = false;
  version: number;

  constructor(options: RpcPeerOptions & { role: R }) {
    this.role = options.role;
    this.transport = options.transport;
    this.version = options.version ?? PROTOCOL_VERSION;
    this.now = options.now ?? (() => Date.now());
    this.defaultDeadlineMs = options.defaultDeadlineMs ?? 30_000;
    this.logger = options.logger ?? noopLogger;
    this.userIdProvider = options.userIdProvider;
    this.responses = new IdempotencyCache<ResponseEnvelope>({
      now: this.now,
      ...options.idempotency,
    });
    this.transport.onMessage((data) => {
      void this.receive(data);
    });
    this.transport.onClose((reason) => {
      this.handleClose(reason);
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  // --- Émission -------------------------------------------------------------------------------

  async request<T extends RequestTypesFrom<R>>(
    type: T,
    payload: RequestPayload<T>,
    options: RequestOptions = {},
  ): Promise<ParsedResponsePayload<T>> {
    if (this.closed) {
      throw new ProtocolError('E_INTERRUPTED', 'transport closed', { retryable: true });
    }
    const id = options.id ?? ulid(this.now());
    const deadlineMs = options.deadlineMs ?? this.defaultDeadlineMs;
    const userId = options.userId ?? this.userIdProvider?.();
    const envelope: RequestEnvelope = {
      v: this.version,
      kind: 'req',
      id,
      type,
      ts: this.now(),
      deadlineMs,
      ...(userId === undefined ? {} : { userId }),
      payload,
    };
    const raw = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new ProtocolError(
            'E_TIMEOUT',
            `request ${type} (${id}) timed out after ${String(deadlineMs)} ms`,
            {
              details: { type, id, deadlineMs },
            },
          ),
        );
      }, deadlineMs);
      this.pending.set(id, { type, resolve, reject, timer });
      try {
        this.transport.send(JSON.stringify(envelope));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new ProtocolError('E_IO', 'transport send failed', { cause: error }));
      }
    });
    const schema: z.ZodType = REQUESTS[type].response;
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new ProtocolError('E_INVALID_PAYLOAD', `invalid response payload for ${type}`, {
        details: { type, issues: parsed.error.issues },
      });
    }
    return parsed.data as ParsedResponsePayload<T>;
  }

  emit<T extends EventTypesFrom<R>>(
    type: T,
    payload: EventPayload<T>,
    options: { id?: string } = {},
  ): string | undefined {
    if (this.closed) return undefined;
    const def = EVENTS[type];
    const id = options.id ?? (def.critical ? ulid(this.now()) : undefined);
    const envelope: EventEnvelope = {
      v: this.version,
      kind: 'event',
      type,
      ts: this.now(),
      ...(id === undefined ? {} : { id }),
      payload,
    };
    this.transport.send(JSON.stringify(envelope));
    return id;
  }

  // --- Réception ------------------------------------------------------------------------------

  handle<T extends Exclude<RequestType, RequestTypesFrom<R>>>(
    type: T,
    handler: RequestHandler<T>,
  ): this {
    this.requestHandlers.set(type, handler);
    return this;
  }

  on<T extends Exclude<EventType, EventTypesFrom<R>>>(
    type: T,
    handler: EventHandler<T>,
  ): () => void {
    let set = this.eventHandlers.get(type);
    if (!set) {
      set = new Set();
      this.eventHandlers.set(type, set);
    }
    const h = handler as unknown as EventHandler<EventType>;
    set.add(h);
    return () => {
      set.delete(h);
    };
  }

  private async receive(data: string): Promise<void> {
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      this.logger.warn('rpc: unparseable frame ignored');
      return;
    }
    const parsed = envelopeSchema.safeParse(json);
    if (!parsed.success) {
      // Requête malformée mais avec un id exploitable → réponse d'erreur plutôt que silence.
      const maybe = json as { kind?: unknown; id?: unknown; type?: unknown } | null;
      if (maybe?.kind === 'req' && typeof maybe.id === 'string') {
        this.sendResponse(
          maybe.id,
          typeof maybe.type === 'string' ? maybe.type : 'unknown',
          new ProtocolError('E_INVALID_PAYLOAD', 'malformed request envelope', {
            details: { issues: parsed.error.issues },
          }),
        );
      } else {
        this.logger.warn('rpc: invalid envelope ignored', { issues: parsed.error.issues });
      }
      return;
    }
    const envelope = parsed.data;
    switch (envelope.kind) {
      case 'req':
        await this.receiveRequest(envelope);
        return;
      case 'res':
        this.receiveResponse(envelope);
        return;
      case 'event':
        await this.receiveEvent(envelope);
        return;
    }
  }

  private async receiveRequest(envelope: RequestEnvelope): Promise<void> {
    const cached = this.responses.get(envelope.id);
    if (cached) {
      this.transport.send(JSON.stringify(cached));
      return;
    }
    let flight = this.inFlight.get(envelope.id);
    if (!flight) {
      flight = this.executeRequest(envelope);
      this.inFlight.set(envelope.id, flight);
    }
    const response = await flight;
    this.inFlight.delete(envelope.id);
    this.responses.set(envelope.id, response);
    if (!this.closed) this.transport.send(JSON.stringify(response));
  }

  private async executeRequest(envelope: RequestEnvelope): Promise<ResponseEnvelope> {
    const { id, type } = envelope;
    if (!isRequestType(type)) {
      return this.buildResponse(
        id,
        type,
        new ProtocolError('E_UNSUPPORTED_TYPE', `unsupported request type: ${type}`, {
          details: { type },
        }),
      );
    }
    const handler = this.requestHandlers.get(type);
    if (!handler) {
      return this.buildResponse(
        id,
        type,
        new ProtocolError('E_UNSUPPORTED_TYPE', `no handler for request type: ${type}`, {
          details: { type },
        }),
      );
    }
    const def = REQUESTS[type];
    const requestSchema: z.ZodType = def.request;
    const payload = requestSchema.safeParse(envelope.payload);
    if (!payload.success) {
      return this.buildResponse(
        id,
        type,
        new ProtocolError('E_INVALID_PAYLOAD', `invalid payload for ${type}`, {
          details: { type, issues: payload.error.issues },
        }),
      );
    }
    const ctx: RequestContext = {
      id,
      type,
      ts: envelope.ts,
      userId: envelope.userId,
      deadlineMs: envelope.deadlineMs,
    };
    try {
      const result: unknown = await handler(payload.data as never, ctx);
      const responseSchema: z.ZodType = def.response;
      const out = responseSchema.safeParse(result);
      if (!out.success) {
        this.logger.warn('rpc: handler returned an invalid response', {
          type,
          issues: out.error.issues,
        });
        return this.buildResponse(
          id,
          type,
          new ProtocolError('E_INTERNAL', `handler for ${type} produced an invalid response`, {
            details: { type, issues: out.error.issues },
          }),
        );
      }
      return this.buildResponse(id, type, undefined, result);
    } catch (error) {
      if (isProtocolError(error)) return this.buildResponse(id, type, error);
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn('rpc: handler threw', { type, message });
      return this.buildResponse(
        id,
        type,
        new ProtocolError('E_INTERNAL', message, { cause: error, details: { type } }),
      );
    }
  }

  private receiveResponse(envelope: ResponseEnvelope): void {
    const pending = this.pending.get(envelope.re);
    if (!pending) {
      this.logger.warn('rpc: response without pending request (late or duplicate)', {
        re: envelope.re,
      });
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(envelope.re);
    if (envelope.ok) {
      pending.resolve(envelope.payload);
    } else {
      pending.reject(
        envelope.error
          ? ProtocolError.fromPayload(envelope.error)
          : new ProtocolError('E_INTERNAL', 'error response without error payload'),
      );
    }
  }

  private async receiveEvent(envelope: EventEnvelope): Promise<void> {
    const { type } = envelope;
    if (!isEventType(type)) {
      this.logger.warn('rpc: unknown event type ignored', { type });
      return;
    }
    const handlers = this.eventHandlers.get(type);
    if (!handlers || handlers.size === 0) return;
    const payloadSchema: z.ZodType = EVENTS[type].payload;
    const payload = payloadSchema.safeParse(envelope.payload);
    if (!payload.success) {
      this.logger.warn('rpc: invalid event payload ignored', {
        type,
        issues: payload.error.issues,
      });
      return;
    }
    const ctx: EventContext = { type, ts: envelope.ts, id: envelope.id };
    for (const handler of handlers) {
      try {
        await handler(payload.data as never, ctx);
      } catch (error) {
        this.logger.warn('rpc: event handler threw', {
          type,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  // --- Internes -------------------------------------------------------------------------------

  private buildResponse(
    re: string,
    type: string,
    error: ProtocolError | undefined,
    payload?: unknown,
  ): ResponseEnvelope {
    return error
      ? {
          v: this.version,
          kind: 'res',
          re,
          type,
          ts: this.now(),
          ok: false,
          error: error.toPayload(),
        }
      : { v: this.version, kind: 'res', re, type, ts: this.now(), ok: true, payload };
  }

  private sendResponse(re: string, type: string, error: ProtocolError): void {
    if (this.closed) return;
    this.transport.send(JSON.stringify(this.buildResponse(re, type, error)));
  }

  private handleClose(reason: string | undefined): void {
    this.closed = true;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(
        new ProtocolError(
          'E_INTERRUPTED',
          `transport closed while awaiting ${pending.type} (${id})`,
          {
            retryable: true,
            details: { type: pending.type, id, ...(reason === undefined ? {} : { reason }) },
          },
        ),
      );
    }
    this.pending.clear();
  }
}

export function createRpcPeer<R extends Role>(options: RpcPeerOptions & { role: R }): RpcPeer<R> {
  return new RpcPeer<R>(options);
}
