/**
 * Lot 4 — webhooks sortants (doc 02 §10, doc 03 §6, doc 04 §6). Calqué sur le service de
 * notifications : abonné au bus, il filtre par CATÉGORIE (`notificationTypeOf`, les mêmes cases
 * que la cloche et le push) et rend le texte avec le même `render` localisé — un salon Discord
 * reçoit le titre que le téléphone aurait reçu, dans la langue choisie pour le webhook. Deux
 * différences voulues :
 *  - une file PAR webhook : un endpoint lent ne retarde ni les autres ni le push ;
 *  - des réessais bornés (1 s, 5 s, 30 s ; `Retry-After` honoré jusqu'à 60 s) sur les seules
 *    réponses transitoires (réseau, 408, 429, 5xx) — un 404 est définitif, on ne martèle pas.
 * Santé sur la ligne : `fail_count` consécutif, `last_error` en clair, événement `webhook.failed`
 * UNE fois par épisode (à la première livraison perdue) et `webhook.recovered` quand ça repasse.
 * Un webhook ne reçoit jamais un événement qui parle de lui-même (pas de boucle). L'URL est
 * revalidée et son adresse épinglée à CHAQUE envoi (`webhooks/ssrf.ts`), pas seulement à la saisie.
 */
import type { FastifyBaseLogger } from 'fastify';
import { eq } from 'drizzle-orm';

import { ulid } from '@mmo/protocol';
import {
  MAX_WEBHOOKS,
  NOTIFICATION_DEFAULTS,
  NOTIFICATION_TYPES,
  notificationTypeOf,
  type EventDto,
  type NotificationType,
  type PushPayload,
  type WebhookCreateInput,
  type WebhookDto,
  type WebhookPatchInput,
  type WebhookTestResult,
} from '@mmo/protocol/client';
import type { Locale } from '@mmo/shared';

import type { MmoDatabase } from '../db/client.js';
import { webhooks, type WebhookRow } from '../db/schema.js';
import { AppError } from '../errors.js';
import { parseJson, toJson } from '../util/json.js';
import type { EventBus } from './events.js';
import { SIGNATURE_HEADER, newWebhookSecret, signWebhook } from './webhooks/signature.js';
import {
  WebhookTargetError,
  resolveWebhookTarget,
  type LookupFn,
  type WebhookTarget,
} from './webhooks/ssrf.js';
import {
  httpTransport,
  type WebhookResponse,
  type WebhookTransport,
} from './webhooks/transport.js';

export { SIGNATURE_HEADER, signWebhook, verifyWebhookSignature } from './webhooks/signature.js';

/** Après le premier essai : 1 s, 5 s, 30 s. Au-delà, la livraison est perdue (et comptée). */
export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [1_000, 5_000, 30_000];
/** `Retry-After` plus long que ça : on ne bloque pas la file d'un webhook pendant des minutes. */
const MAX_RETRY_AFTER_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 15_000;
/** Ce qu'on garde d'un corps de réponse en erreur (un 400 Discord tient en une ligne). */
const ERROR_EXCERPT = 160;

/** Couleurs des embeds Discord par sévérité (bleu, orange, rouge, violet). */
const EMBED_COLORS: Readonly<Record<EventDto['severity'], number>> = {
  debug: 0x95a5a6,
  info: 0x2f80ed,
  warning: 0xf2994a,
  error: 0xeb5757,
  critical: 0x9b51e0,
};

export interface WebhooksServiceOptions {
  /** Résolveur DNS (tests : faux) ; défaut `dns.lookup` toutes adresses. */
  lookup?: LookupFn | undefined;
  /** Transport (tests : faux) ; défaut `node:https` avec adresse épinglée. */
  transport?: WebhookTransport | undefined;
  /** Attentes entre essais (tests : courtes). */
  retryDelaysMs?: readonly number[] | undefined;
  timeoutMs?: number | undefined;
}

export interface WebhooksDeps extends WebhooksServiceOptions {
  db: MmoDatabase;
  now: () => number;
  events: EventBus;
  logger: FastifyBaseLogger;
  /** Le rendu localisé du service de notifications (même titre, même corps). */
  render(event: EventDto, locale: Locale): PushPayload | undefined;
  serverName(serverId: string): string | undefined;
  machineName(machineId: string): string | undefined;
  /** `panel.publicUrl` : rend les liens absolus (sinon ils restent relatifs). */
  publicUrl(): string | undefined;
  /** `User-Agent: mmo-panel/<version>`. */
  version: string;
}

interface Outcome {
  ok: boolean;
  status: number | null;
  error: string | null;
}

/** URL montrée aux administrateurs : jeton Discord masqué, query string jamais renvoyée. */
export function displayUrl(kind: WebhookRow['kind'], url: string): string {
  try {
    const parsed = new URL(url);
    if (kind === 'discord') {
      const segments = parsed.pathname.split('/');
      segments[segments.length - 1] = '••••';
      return `${parsed.origin}${segments.join('/')}`;
    }
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

function knownTypes(values: readonly string[]): NotificationType[] {
  const known = new Set<string>(NOTIFICATION_TYPES);
  return [...new Set(values)].filter((v): v is NotificationType => known.has(v));
}

function defaultTypes(): NotificationType[] {
  return NOTIFICATION_TYPES.filter((type) => NOTIFICATION_DEFAULTS[type]);
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'AbortError' || error.name === 'TimeoutError') return 'timeout';
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? `${code}: ${error.message}` : error.message;
  }
  return String(error);
}

function describeHttp(res: WebhookResponse): string {
  const excerpt = res.body.replace(/\s+/g, ' ').trim().slice(0, ERROR_EXCERPT);
  return excerpt === '' ? `HTTP ${String(res.status)}` : `HTTP ${String(res.status)}: ${excerpt}`;
}

/** Discord met `retry_after` (secondes, décimales) dans le corps du 429 ; l'en-tête est parfois absent. */
function retryAfterOf(res: WebhookResponse): number | undefined {
  if (res.retryAfterMs !== undefined) return res.retryAfterMs;
  const parsed = parseJson<{ retry_after?: unknown }>(res.body, {});
  return typeof parsed.retry_after === 'number' ? Math.ceil(parsed.retry_after * 1000) : undefined;
}

export class WebhooksService {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly sleepers = new Set<() => void>();
  private readonly idleWaiters: (() => void)[] = [];
  private inflight = 0;
  private closed = false;
  private readonly unsubscribe: () => void;
  private readonly lookup: LookupFn | undefined;
  private readonly transport: WebhookTransport;
  private readonly retryDelays: readonly number[];
  private readonly timeoutMs: number;

  constructor(private readonly deps: WebhooksDeps) {
    this.lookup = deps.lookup;
    this.transport = deps.transport ?? httpTransport;
    this.retryDelays = deps.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.unsubscribe = deps.events.subscribe((event) => {
      this.dispatch(event);
    });
  }

  dispose(): void {
    this.closed = true;
    this.unsubscribe();
    for (const wake of this.sleepers) wake();
  }

  /** Attend que toutes les files soient vides (tests) — y compris les événements qu'une livraison a publiés. */
  flush(): Promise<void> {
    if (this.inflight === 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  // --- Gestion --------------------------------------------------------------------------------------

  list(): WebhookDto[] {
    return this.deps.db.select().from(webhooks).all().map(toDto);
  }

  get(id: string): WebhookDto {
    return toDto(this.require(id));
  }

  async create(
    input: WebhookCreateInput,
    defaults: { locale: Locale },
  ): Promise<{ webhook: WebhookDto; secret: string | null }> {
    if (this.list().length >= MAX_WEBHOOKS) {
      throw new AppError('E_VALIDATION', `at most ${String(MAX_WEBHOOKS)} webhooks`, {
        details: { key: 'name', reason: 'TOO_MANY', max: MAX_WEBHOOKS },
      });
    }
    await this.validateUrl(input.url, input.kind);
    const now = this.deps.now();
    const secret = input.kind === 'json' ? newWebhookSecret() : null;
    const row: WebhookRow = {
      id: ulid(),
      name: input.name,
      kind: input.kind,
      url: input.url,
      secret,
      enabled: input.enabled === false ? 0 : 1,
      locale: input.locale ?? defaults.locale,
      types: toJson(input.types === undefined ? defaultTypes() : knownTypes(input.types)),
      createdAt: now,
      updatedAt: now,
      lastAttemptAt: null,
      lastDeliveredAt: null,
      lastStatus: null,
      lastError: null,
      failCount: 0,
    };
    this.deps.db.insert(webhooks).values(row).run();
    return { webhook: toDto(row), secret };
  }

  async update(id: string, patch: WebhookPatchInput): Promise<WebhookDto> {
    const row = this.require(id);
    if (patch.url !== undefined && patch.url !== row.url)
      await this.validateUrl(patch.url, row.kind);
    const changes: Partial<WebhookRow> = { updatedAt: this.deps.now() };
    if (patch.name !== undefined) changes.name = patch.name;
    if (patch.url !== undefined) changes.url = patch.url;
    if (patch.locale !== undefined) changes.locale = patch.locale;
    if (patch.types !== undefined) changes.types = toJson(knownTypes(patch.types));
    if (patch.enabled !== undefined) changes.enabled = patch.enabled ? 1 : 0;
    // Une nouvelle URL repart de zéro : l'historique d'échecs parlait de l'ancienne.
    if (patch.url !== undefined && patch.url !== row.url) {
      Object.assign(changes, { failCount: 0, lastError: null, lastStatus: null });
    }
    this.deps.db.update(webhooks).set(changes).where(eq(webhooks.id, id)).run();
    return toDto(this.require(id));
  }

  remove(id: string): void {
    this.require(id);
    this.deps.db.delete(webhooks).where(eq(webhooks.id, id)).run();
    this.queues.delete(id);
  }

  /** Nouveau secret (genre `json` seulement) — l'ancien cesse de valoir immédiatement. */
  rotateSecret(id: string): string {
    const row = this.require(id);
    if (row.kind !== 'json') {
      throw new AppError('E_VALIDATION', 'only signed JSON webhooks carry a secret', {
        details: { key: 'kind', reason: 'NO_SECRET' },
      });
    }
    const secret = newWebhookSecret();
    this.deps.db
      .update(webhooks)
      .set({ secret, updatedAt: this.deps.now() })
      .where(eq(webhooks.id, id))
      .run();
    return secret;
  }

  /** Un envoi immédiat, sans réessai, hors file : le résultat revient à l'écran tel quel. */
  async test(id: string): Promise<WebhookTestResult> {
    const row = this.require(id);
    const event: EventDto = {
      id: 0,
      ts: this.deps.now(),
      type: 'webhook.test',
      severity: 'info',
      machineId: null,
      serverId: null,
      userId: null,
      payload: { webhookId: id, webhook: row.name },
    };
    const payload = this.deps.render(event, row.locale as Locale);
    if (payload === undefined) throw new AppError('E_INTERNAL', 'test payload not rendered');
    const started = performance.now();
    const outcome = (await this.send(row, event, payload, false)) ?? {
      ok: false,
      status: null,
      error: 'panel closing',
    };
    this.record(id, outcome, 'test');
    return {
      ok: outcome.ok,
      status: outcome.status,
      error: outcome.error,
      durationMs: Math.round(performance.now() - started),
    };
  }

  // --- Livraison --------------------------------------------------------------------------------------

  private dispatch(event: EventDto): void {
    if (this.closed) return;
    const category = notificationTypeOf(event);
    if (category === undefined) return;
    const about = (event.payload as { webhookId?: unknown } | null)?.webhookId;
    for (const row of this.deps.db.select().from(webhooks).where(eq(webhooks.enabled, 1)).all()) {
      if (about === row.id) continue;
      if (!parseJson<string[]>(row.types, []).includes(category)) continue;
      this.enqueue(row.id, event);
    }
  }

  private enqueue(id: string, event: EventDto): void {
    const previous = this.queues.get(id) ?? Promise.resolve();
    this.inflight += 1;
    const next = previous
      .then(() => this.deliver(id, event))
      .catch((error: unknown) => {
        this.deps.logger.warn({ err: error, webhook: id }, 'webhook delivery crashed');
      })
      .finally(() => {
        this.inflight -= 1;
        if (this.inflight === 0) {
          const waiters = this.idleWaiters.splice(0);
          for (const wake of waiters) wake();
        }
      });
    this.queues.set(id, next);
  }

  private async deliver(id: string, event: EventDto): Promise<void> {
    if (this.closed) return;
    const row = this.row(id);
    // Supprimé ou désactivé pendant l'attente dans la file : rien à envoyer.
    if (row === undefined || row.enabled === 0) return;
    const payload = this.deps.render(event, row.locale as Locale);
    if (payload === undefined) return;
    const outcome = await this.send(row, event, payload, true);
    if (outcome !== undefined) this.record(id, outcome, 'event');
  }

  /** `undefined` = panel en cours de fermeture : ni succès ni échec, on ne compte rien. */
  private async send(
    row: WebhookRow,
    event: EventDto,
    payload: PushPayload,
    retries: boolean,
  ): Promise<Outcome | undefined> {
    let target: WebhookTarget;
    try {
      target = await resolveWebhookTarget(row.url, {
        lookup: this.lookup,
        discord: row.kind === 'discord',
      });
    } catch (error) {
      return {
        ok: false,
        status: null,
        error:
          error instanceof WebhookTargetError
            ? `${error.reason}: ${error.message}`
            : describeError(error),
      };
    }
    const category = notificationTypeOf(event) ?? null;
    const delivery = ulid();
    const ts = this.deps.now();
    const body = Buffer.from(
      JSON.stringify(
        row.kind === 'discord'
          ? this.discordBody(event, payload)
          : this.jsonBody(event, payload, category, delivery, ts),
      ),
    );
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'user-agent': `mmo-panel/${this.deps.version}`,
      'x-mmo-event': event.type,
      'x-mmo-delivery': delivery,
    };
    if (category !== null) headers['x-mmo-category'] = category;
    if (row.secret !== null) headers[SIGNATURE_HEADER] = signWebhook(row.secret, ts, body);
    const delays = retries ? this.retryDelays : [];
    for (let attempt = 0; ; attempt += 1) {
      let wait: number;
      try {
        const res = await this.transport({ target, headers, body, timeoutMs: this.timeoutMs });
        if (res.status >= 200 && res.status < 300)
          return { ok: true, status: res.status, error: null };
        const transient = res.status === 408 || res.status === 429 || res.status >= 500;
        if (!transient || attempt >= delays.length) {
          return { ok: false, status: res.status, error: describeHttp(res) };
        }
        wait = Math.max(delays[attempt] ?? 0, retryAfterOf(res) ?? 0);
      } catch (error) {
        if (attempt >= delays.length)
          return { ok: false, status: null, error: describeError(error) };
        wait = delays[attempt] ?? 0;
      }
      this.deps.logger.debug(
        { webhook: row.id, attempt: attempt + 1, waitMs: wait },
        'webhook delivery will be retried',
      );
      await this.sleep(Math.min(wait, MAX_RETRY_AFTER_MS));
      if (this.closed) return undefined;
    }
  }

  private record(id: string, outcome: Outcome, source: 'event' | 'test'): void {
    const row = this.row(id);
    if (row === undefined) return; // supprimé pendant l'envoi
    const now = this.deps.now();
    if (outcome.ok) {
      this.deps.db
        .update(webhooks)
        .set({
          lastAttemptAt: now,
          lastDeliveredAt: now,
          lastStatus: outcome.status,
          lastError: null,
          failCount: 0,
        })
        .where(eq(webhooks.id, id))
        .run();
      if (row.failCount > 0) {
        this.deps.logger.info(
          { webhook: id, name: row.name, failures: row.failCount },
          'webhook delivering again',
        );
        this.deps.events.publish({
          type: 'webhook.recovered',
          severity: 'info',
          payload: { webhookId: id, webhook: row.name, failures: row.failCount },
        });
      }
      return;
    }
    if (source === 'test') {
      // L'administrateur regarde le résultat : pas d'épisode, pas de notification.
      this.deps.db
        .update(webhooks)
        .set({ lastAttemptAt: now, lastStatus: outcome.status, lastError: outcome.error })
        .where(eq(webhooks.id, id))
        .run();
      return;
    }
    const failCount = row.failCount + 1;
    this.deps.db
      .update(webhooks)
      .set({ lastAttemptAt: now, lastStatus: outcome.status, lastError: outcome.error, failCount })
      .where(eq(webhooks.id, id))
      .run();
    const context = { webhook: id, name: row.name, status: outcome.status, error: outcome.error };
    if (failCount === 1) {
      this.deps.logger.warn(context, 'webhook delivery failed');
      this.deps.events.publish({
        type: 'webhook.failed',
        severity: 'error',
        payload: {
          webhookId: id,
          webhook: row.name,
          reason: outcome.error,
          status: outcome.status,
        },
      });
    } else {
      this.deps.logger.warn({ ...context, failCount }, 'webhook still failing');
    }
  }

  // --- Corps ------------------------------------------------------------------------------------------

  private absoluteUrl(path: string): string {
    const base = this.deps.publicUrl();
    return base === undefined || base === '' ? path : `${base.replace(/\/$/, '')}${path}`;
  }

  private names(event: EventDto): { server: string | null; machine: string | null } {
    return {
      server: event.serverId === null ? null : (this.deps.serverName(event.serverId) ?? null),
      machine: event.machineId === null ? null : (this.deps.machineName(event.machineId) ?? null),
    };
  }

  /** Un embed par événement : titre et corps localisés, couleur par sévérité, lien vers le panel. */
  private discordBody(event: EventDto, payload: PushPayload): unknown {
    const { server, machine } = this.names(event);
    const footer = [server, machine].filter((v) => v !== null).join(' · ');
    const link = this.absoluteUrl(payload.url);
    return {
      username: 'MMO',
      embeds: [
        {
          title: payload.title.slice(0, 256),
          description: payload.body.slice(0, 4096),
          color: EMBED_COLORS[event.severity],
          timestamp: new Date(event.ts).toISOString(),
          ...(link.startsWith('https://') || link.startsWith('http://') ? { url: link } : {}),
          footer: { text: footer === '' ? 'MinecraftManagerOnline' : footer },
        },
      ],
    };
  }

  /** Charge signée : l'événement brut (ce que le bus a publié) plus le rendu, pour n8n/Home Assistant. */
  private jsonBody(
    event: EventDto,
    payload: PushPayload,
    category: NotificationType | null,
    delivery: string,
    ts: number,
  ): unknown {
    const { server, machine } = this.names(event);
    return {
      id: delivery,
      ts,
      category,
      event: {
        id: event.id,
        ts: event.ts,
        type: event.type,
        severity: event.severity,
        serverId: event.serverId,
        machineId: event.machineId,
        payload: event.payload ?? null,
      },
      server,
      machine,
      title: payload.title,
      body: payload.body,
      url: this.absoluteUrl(payload.url),
      locale: payload.locale,
    };
  }

  // --- Divers -----------------------------------------------------------------------------------------

  private async validateUrl(url: string, kind: WebhookRow['kind']): Promise<void> {
    try {
      await resolveWebhookTarget(url, { lookup: this.lookup, discord: kind === 'discord' });
    } catch (error) {
      if (error instanceof WebhookTargetError) {
        throw new AppError('E_VALIDATION', error.message, {
          details: { key: 'url', reason: error.reason, ...error.details },
        });
      }
      throw error;
    }
  }

  private row(id: string): WebhookRow | undefined {
    return this.deps.db.select().from(webhooks).where(eq(webhooks.id, id)).get();
  }

  private require(id: string): WebhookRow {
    const row = this.row(id);
    if (row === undefined) throw new AppError('E_NOT_FOUND', `webhook ${id} not found`);
    return row;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const handle: { timer?: NodeJS.Timeout } = {};
      const wake = (): void => {
        clearTimeout(handle.timer);
        this.sleepers.delete(wake);
        resolve();
      };
      this.sleepers.add(wake);
      handle.timer = setTimeout(wake, ms);
      handle.timer.unref();
    });
  }
}

function toDto(row: WebhookRow): WebhookDto {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    url: displayUrl(row.kind, row.url),
    enabled: row.enabled === 1,
    locale: row.locale as Locale,
    types: knownTypes(parseJson<string[]>(row.types, [])),
    hasSecret: row.secret !== null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastAttemptAt: row.lastAttemptAt,
    lastDeliveredAt: row.lastDeliveredAt,
    lastStatus: row.lastStatus,
    lastError: row.lastError,
    failCount: row.failCount,
  };
}
