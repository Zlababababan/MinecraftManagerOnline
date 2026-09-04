/**
 * Phase 10 — notifications (doc 02 §10, doc 03 §5) : préférences par type (`notification_prefs`),
 * abonnements Web Push (`push_subscriptions`), livraison **localisée par destinataire** (instance
 * i18n isolée par langue, doc 03 §7), purge des abonnements morts (404/410 ou échecs répétés) et
 * centre de notifications in-app (liste filtrée par préférences + curseur « vu » par utilisateur).
 */
import type { FastifyBaseLogger } from 'fastify';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';

import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_DEFAULTS,
  NOTIFICATION_TYPES,
  notificationTypeOf,
  type EventDto,
  type NotificationChannel,
  type NotificationChannelPrefsDto,
  type NotificationPrefsDto,
  type NotificationPrefsPut,
  type NotificationType,
  type NotificationsResult,
  type PushAction,
  type PushPayload,
  type QuietHours,
  type PushSubscribeInput,
  type PushSubscriptionDto,
} from '@mmo/protocol/client';
import { createI18n, wallClockIn, type Locale } from '@mmo/shared';

type I18nInstance = ReturnType<typeof createI18n>;

/** Clés dynamiques : le typage strict des ressources (côté web) ne s'applique pas ici. */
function tr(i18n: I18nInstance, key: string, params?: Record<string, unknown>): string {
  return (i18n.t as (k: string, o?: Record<string, unknown>) => string)(key, params);
}

import type { MmoDatabase } from '../db/client.js';
import {
  events,
  notificationChannelPrefs,
  notificationMutes,
  notificationPrefs,
  pushSubscriptions,
  users,
} from '../db/schema.js';
import { AppError } from '../errors.js';
import { parseJson } from '../util/json.js';
import type { EventBus } from './events.js';
import { sendWebPush, type VapidKeys } from './push/webpush.js';
import { SETTING_KEYS, type SettingsService } from './settings.js';

/** Types d'événements du bus susceptibles de produire une notification (filtre SQL du centre). */
const BUS_TYPES = [
  'server.stateChanged',
  'task.completed',
  'agent.log',
  'machine.paired',
  'server.adopted',
  'server.removed',
  'server.deleted',
  'server.migrated',
  'server.conflict',
  'player.action',
  'server.startFailed',
  'watchdog.alert',
  'agent.offline',
  'task.failed',
  'migration.done',
  'migration.failed',
  'agent.updateApplied',
  'agent.updateRolledBack',
  'schedule.run',
  'port.conflict',
  'player.joined',
  'player.left',
  'backup.overdue',
  'backup.corrupted',
  'alert.firing',
  'alert.resolved',
  'panel.updateAvailable',
  'panel.backupFailed',
  'webhook.failed',
  'webhook.recovered',
] as const;

/** Au-delà : l'abonnement est considéré mort même sans 410 (iOS purge silencieusement). */
const MAX_FAILURES = 8;

/**
 * L'instant tombe-t-il dans la plage silencieuse ? Les bornes sont des minutes murales, et la
 * plage TRAVERSE MINUIT dans le cas normal (22 h → 7 h) : c'est `from > to`. Borne basse incluse,
 * borne haute exclue — à 7 h pile, le téléphone sonne de nouveau.
 */
export function inQuietHours(minuteOfDay: number, from: number, to: number): boolean {
  if (from === to) return false; // une plage vide ne fait pas taire une journée entière
  return from < to
    ? minuteOfDay >= from && minuteOfDay < to
    : minuteOfDay >= from || minuteOfDay < to;
}

/**
 * Ce qui traverse les heures calmes. Être silencieux la nuit ne doit pas vouloir dire apprendre
 * au matin que le serveur est tombé à 23 h : les erreurs passent, et les **alertes** aussi —
 * `alert.firing` porte la sévérité `warning` alors qu'elle nomme précisément les urgences du
 * produit (serveur tombé, machine hors ligne, disque plein, TPS effondré).
 */
export function isCriticalForQuietHours(event: Pick<EventDto, 'type' | 'severity'>): boolean {
  return event.severity === 'error' || event.type === 'alert.firing';
}

export interface NotificationsDeps {
  db: MmoDatabase;
  now: () => number;
  events: EventBus;
  settings: SettingsService;
  logger: FastifyBaseLogger;
  fetchImpl: typeof fetch;
  serverName(serverId: string): string | undefined;
  machineName(machineId: string): string | undefined;
  /** Lot 8 : l'utilisateur a-t-il le droit de voir cet événement (droits par serveur) ? Défaut : oui. */
  visibleTo?: (userId: string, event: EventDto) => boolean;
}

export class NotificationsService {
  private readonly i18n = new Map<Locale, I18nInstance>();
  private queue: Promise<void> = Promise.resolve();
  private readonly unsubscribeBus: () => void;

  constructor(private readonly deps: NotificationsDeps) {
    this.unsubscribeBus = deps.events.subscribe((event) => {
      this.queue = this.queue.then(() => this.deliver(event)).catch(() => undefined);
    });
  }

  dispose(): void {
    this.unsubscribeBus();
  }

  /** Attente de la file de livraison (tests). */
  flush(): Promise<void> {
    return this.queue;
  }

  // --- Préférences ------------------------------------------------------------------------------

  prefs(userId: string): NotificationPrefsDto {
    const out = { ...NOTIFICATION_DEFAULTS } as Record<NotificationType, boolean>;
    const rows = this.deps.db
      .select()
      .from(notificationPrefs)
      .where(eq(notificationPrefs.userId, userId))
      .all();
    for (const row of rows) {
      if ((NOTIFICATION_TYPES as readonly string[]).includes(row.eventType)) {
        out[row.eventType as NotificationType] = row.enabled === 1;
      }
    }
    return out;
  }

  /**
   * Réglages effectifs par canal. Chaîne de repli, du plus précis au plus général : préférence de
   * ce canal, sinon ancienne préférence commune, sinon défaut du catalogue. Une catégorie inconnue
   * n'apparaît pas ici, et `enabled()` la laisse passer : mieux vaut une notification en trop
   * qu'un silence après une mise à jour.
   */
  channelPrefs(userId: string): NotificationChannelPrefsDto {
    const shared = this.prefs(userId);
    const perChannel = new Map<string, boolean>();
    for (const row of this.deps.db
      .select()
      .from(notificationChannelPrefs)
      .where(eq(notificationChannelPrefs.userId, userId))
      .all()) {
      perChannel.set(`${row.channel}:${row.eventType}`, row.enabled === 1);
    }
    const out = {} as Record<NotificationChannel, NotificationPrefsDto>;
    for (const channel of NOTIFICATION_CHANNELS) {
      const map = {} as Record<NotificationType, boolean>;
      for (const type of NOTIFICATION_TYPES) {
        // `shared` part des défauts du catalogue : une catégorie tout juste ajoutée y est donc
        // déjà, avec sa valeur d'origine. C'est ce qui évite qu'une mise à jour rende muette une
        // catégorie que personne n'a encore vue.
        map[type] = perChannel.get(`${channel}:${type}`) ?? shared[type];
      }
      out[channel] = map;
    }
    return out;
  }

  // --- Heures calmes et silence par serveur (lot 8) ---------------------------------------------

  quietHours(userId: string): QuietHours | null {
    const row = this.deps.db.select().from(users).where(eq(users.id, userId)).get();
    return row?.quietFrom === null || row?.quietFrom === undefined || row.quietTo === null
      ? null
      : { from: row.quietFrom, to: row.quietTo };
  }

  setQuietHours(userId: string, value: QuietHours | null): QuietHours | null {
    this.deps.db
      .update(users)
      .set({ quietFrom: value?.from ?? null, quietTo: value?.to ?? null })
      .where(eq(users.id, userId))
      .run();
    return value;
  }

  /** Les serveurs que CET utilisateur a mis en silence (le nom vient de l'appelant). */
  mutedServerIds(userId: string): Set<string> {
    return new Set(
      this.deps.db
        .select({ serverId: notificationMutes.serverId })
        .from(notificationMutes)
        .where(eq(notificationMutes.userId, userId))
        .all()
        .map((r) => r.serverId),
    );
  }

  mutes(userId: string): { serverId: string; mutedAt: number }[] {
    return this.deps.db
      .select()
      .from(notificationMutes)
      .where(eq(notificationMutes.userId, userId))
      .all()
      .map((r) => ({ serverId: r.serverId, mutedAt: r.createdAt }));
  }

  setMuted(userId: string, serverId: string, muted: boolean): boolean {
    if (!muted) {
      this.deps.db
        .delete(notificationMutes)
        .where(and(eq(notificationMutes.userId, userId), eq(notificationMutes.serverId, serverId)))
        .run();
      return false;
    }
    this.deps.db
      .insert(notificationMutes)
      .values({ userId, serverId, createdAt: this.deps.now() })
      .onConflictDoNothing()
      .run();
    return true;
  }

  /**
   * Ce push doit-il partir maintenant, pour cet utilisateur ? Deux raisons de se taire, et une
   * seule de passer outre. La cloche du panel, elle, garde tout : c'est l'historique.
   */
  private pushAllowed(userId: string, event: EventDto): boolean {
    if (event.serverId !== null && this.mutedServerIds(userId).has(event.serverId)) return false;
    const quiet = this.quietHours(userId);
    if (quiet === null || isCriticalForQuietHours(event)) return true;
    const wall = wallClockIn(this.deps.now(), this.deps.settings.timeZone());
    return !inQuietHours(wall.hour * 60 + wall.minute, quiet.from, quiet.to);
  }

  /** Cette catégorie passe-t-elle sur ce canal ? (le catalogue est énuméré en entier, jamais de trou) */
  private enabled(userId: string, channel: NotificationChannel, type: NotificationType): boolean {
    return this.channelPrefs(userId)[channel][type];
  }

  setPrefs(userId: string, input: NotificationPrefsPut): NotificationChannelPrefsDto {
    // Sans canal précisé, les deux : c'est le sens de l'ancien réglage unique.
    const channels = input.channel === undefined ? NOTIFICATION_CHANNELS : [input.channel];
    for (const [type, enabled] of Object.entries(input.values)) {
      for (const channel of channels) {
        this.deps.db
          .insert(notificationChannelPrefs)
          .values({ userId, channel, eventType: type, enabled: enabled ? 1 : 0 })
          .onConflictDoUpdate({
            target: [
              notificationChannelPrefs.userId,
              notificationChannelPrefs.channel,
              notificationChannelPrefs.eventType,
            ],
            set: { enabled: enabled ? 1 : 0 },
          })
          .run();
      }
    }
    return this.channelPrefs(userId);
  }

  // --- Abonnements push -------------------------------------------------------------------------

  vapid(): VapidKeys | undefined {
    const publicKey = this.deps.settings.get(SETTING_KEYS.vapidPublicKey);
    const privateKey = this.deps.settings.get(SETTING_KEYS.vapidPrivateKey);
    return publicKey && privateKey ? { publicKey, privateKey } : undefined;
  }

  subscribe(userId: string, input: PushSubscribeInput): PushSubscriptionDto {
    if (this.vapid() === undefined) throw new AppError('E_PUSH_DISABLED', 'VAPID keys missing');
    const t = this.deps.now();
    // Un endpoint est unique par navigateur : s'il change de compte (autre session sur le même
    // appareil), il suit le nouvel utilisateur.
    this.deps.db
      .insert(pushSubscriptions)
      .values({
        userId,
        endpoint: input.endpoint,
        p256dh: input.keys.p256dh,
        auth: input.keys.auth,
        createdAt: t,
        lastSeenAt: t,
        userAgent: input.userAgent ?? null,
        failCount: 0,
      })
      .onConflictDoUpdate({
        target: pushSubscriptions.endpoint,
        set: {
          userId,
          p256dh: input.keys.p256dh,
          auth: input.keys.auth,
          lastSeenAt: t,
          userAgent: input.userAgent ?? null,
          failCount: 0,
        },
      })
      .run();
    const row = this.deps.db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.endpoint, input.endpoint))
      .get();
    if (row === undefined) throw new AppError('E_INTERNAL', 'subscription not stored');
    return toSubscriptionDto(row);
  }

  unsubscribe(userId: string, endpoint: string): boolean {
    return (
      this.deps.db
        .delete(pushSubscriptions)
        .where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, endpoint)))
        .run().changes > 0
    );
  }

  subscriptions(userId: string): PushSubscriptionDto[] {
    return this.deps.db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, userId))
      .orderBy(desc(pushSubscriptions.createdAt))
      .all()
      .map(toSubscriptionDto);
  }

  countSubscriptions(): number {
    return (
      this.deps.db
        .select({ n: sql<number>`count(*)` })
        .from(pushSubscriptions)
        .get()?.n ?? 0
    );
  }

  /** Push de test vers tous les appareils de l'utilisateur ; renvoie le nombre d'envois réussis. */
  async sendTest(userId: string): Promise<{ sent: number; failed: number }> {
    const user = this.deps.db.select().from(users).where(eq(users.id, userId)).get();
    if (user === undefined) throw new AppError('E_NOT_FOUND', 'user not found');
    const i18n = this.i18nFor(user.locale);
    const payload: PushPayload = {
      title: i18n.t('common:notify.test.title'),
      body: i18n.t('common:notify.test.body'),
      url: '/account',
      tag: 'test',
      ts: this.deps.now(),
      locale: user.locale,
    };
    return this.sendToUser(userId, payload, 'test');
  }

  // --- Centre in-app -----------------------------------------------------------------------------

  list(userId: string, limit = 50): NotificationsResult {
    const user = this.deps.db.select().from(users).where(eq(users.id, userId)).get();
    const seenId = user?.notificationsSeenId ?? 0;
    // La cloche a son propre réglage : couper une catégorie sur le téléphone ne doit plus la
    // faire disparaître de l'historique consultable dans le panel.
    const prefs = this.channelPrefs(userId).inapp;
    const rows = this.deps.db
      .select()
      .from(events)
      .where(inArray(events.type, [...BUS_TYPES]))
      .orderBy(desc(events.id))
      .limit(Math.min(limit, 200) * 4)
      .all();
    const notifications: EventDto[] = [];
    for (const row of rows) {
      const event: EventDto = { ...row, payload: parseJson<unknown>(row.payload, null) };
      const type = notificationTypeOf(event);
      if (type === undefined || !prefs[type]) continue;
      if (this.deps.visibleTo?.(userId, event) === false) continue;
      notifications.push(event);
      if (notifications.length >= limit) break;
    }
    return {
      notifications,
      unread: notifications.filter((e) => e.id > seenId).length,
      seenId,
    };
  }

  markSeen(userId: string, id: number): number {
    const current =
      this.deps.db.select().from(users).where(eq(users.id, userId)).get()?.notificationsSeenId ?? 0;
    const next = Math.max(current, id);
    this.deps.db.update(users).set({ notificationsSeenId: next }).where(eq(users.id, userId)).run();
    return next;
  }

  // --- Livraison --------------------------------------------------------------------------------

  /** Pour chaque utilisateur actif ayant activé la catégorie : un push localisé par appareil. */
  async deliver(event: EventDto): Promise<void> {
    const type = notificationTypeOf(event);
    if (type === undefined) return;
    if (this.vapid() === undefined) return;
    const recipients = this.deps.db
      .select({ id: users.id, locale: users.locale })
      .from(users)
      .where(eq(users.isActive, 1))
      .all();
    for (const user of recipients) {
      if (!this.enabled(user.id, 'push', type)) continue;
      if (this.deps.visibleTo?.(user.id, event) === false) continue;
      if (!this.pushAllowed(user.id, event)) continue;
      if (this.subscriptions(user.id).length === 0) continue;
      const payload = this.render(event, user.locale);
      if (payload === undefined) continue;
      await this.sendToUser(user.id, payload, type);
    }
  }

  /** Texte localisé d'une notification (aussi utilisé par le centre in-app via l'API). */
  render(event: EventDto, locale: Locale): PushPayload | undefined {
    const i18n = this.i18nFor(locale);
    const key = notifyKey(event);
    if (key === undefined) return undefined;
    const p = (event.payload ?? {}) as Record<string, unknown>;
    const server =
      event.serverId === null ? '' : (this.deps.serverName(event.serverId) ?? event.serverId);
    const machine =
      event.machineId === null ? '' : (this.deps.machineName(event.machineId) ?? event.machineId);
    const error = p.error as { code?: string; message?: string } | undefined;
    const reason =
      (typeof p.reason === 'string' && p.reason) ||
      (typeof p.message === 'string' && p.message) ||
      (error?.code !== undefined && i18n.exists(`errors:${error.code}`)
        ? tr(i18n, `errors:${error.code}`, { ...(error as Record<string, unknown>) })
        : (error?.message ?? error?.code ?? '')) ||
      '';
    const params = {
      server,
      machine,
      reason,
      kind: text(p.kind),
      action: text(p.action),
      version: text(p.version),
      current: text(p.current),
      port: text(p.port),
      player: text(p.name),
      webhook: text(p.webhook),
      online: text(p.online),
      percent: text(p.percent),
      freeGb: text(p.freeGb),
      tps: text(p.tps),
      scope: text(p.serverName) || text(p.machineName) || server || machine,
      target: text(p.target),
      path: text(p.path),
      hostname: text(p.hostname),
      interpolation: { escapeValue: false },
    };
    const actions = pushActionsFor(event, (k) => tr(i18n, k));
    return {
      title: tr(i18n, `common:notify.${key}.title`, params),
      body: tr(i18n, `common:notify.${key}.body`, params),
      ...(actions.length === 0 ? {} : { actions }),
      url:
        event.serverId !== null
          ? `/servers/${event.serverId}`
          : event.machineId !== null
            ? `/machines/${event.machineId}`
            : '/',
      tag: `${event.type}:${event.serverId ?? event.machineId ?? ''}`,
      eventId: event.id,
      ts: event.ts,
      locale,
    };
  }

  private async sendToUser(
    userId: string,
    payload: PushPayload,
    topic: string,
  ): Promise<{ sent: number; failed: number }> {
    const vapid = this.vapid();
    if (vapid === undefined) throw new AppError('E_PUSH_DISABLED', 'VAPID keys missing');
    const subject = this.subject();
    const body = Buffer.from(JSON.stringify(payload));
    let sent = 0;
    let failed = 0;
    const rows = this.deps.db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, userId))
      .all();
    for (const row of rows) {
      const outcome = await sendWebPush(
        this.deps.fetchImpl,
        { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
        body,
        vapid,
        this.deps.now(),
        { subject, topic: topic.replace(/[^A-Za-z0-9_-]/g, '_'), urgency: 'high' },
      );
      if (outcome.ok) {
        sent += 1;
        this.deps.db
          .update(pushSubscriptions)
          .set({ lastSuccessAt: this.deps.now(), failCount: 0 })
          .where(eq(pushSubscriptions.id, row.id))
          .run();
        continue;
      }
      failed += 1;
      const failures = row.failCount + 1;
      if (outcome.gone || failures >= MAX_FAILURES) {
        this.deps.db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, row.id)).run();
        this.deps.logger.info(
          { userId, endpoint: shortEndpoint(row.endpoint), status: outcome.status },
          'push subscription purged',
        );
      } else {
        this.deps.db
          .update(pushSubscriptions)
          .set({ failCount: failures })
          .where(eq(pushSubscriptions.id, row.id))
          .run();
        this.deps.logger.warn(
          { userId, endpoint: shortEndpoint(row.endpoint), error: outcome.error },
          'push delivery failed',
        );
      }
    }
    return { sent, failed };
  }

  /** `sub` VAPID : l'URL publique du panel si elle existe (sinon un mailto générique). */
  private subject(): string {
    const url = this.deps.settings.get(SETTING_KEYS.publicUrl);
    const email = this.deps.settings.get('access.acme.email');
    if (email) return `mailto:${email}`;
    return url?.startsWith('https://') ? url : 'mailto:admin@localhost';
  }

  private i18nFor(locale: Locale): I18nInstance {
    let instance = this.i18n.get(locale);
    if (instance === undefined) {
      instance = createI18n(locale);
      this.i18n.set(locale, instance);
    }
    return instance;
  }
}

/** Clé `common:notify.<clé>` (sans point, pitfall i18n) pour un événement — `undefined` = ignoré. */
/**
 * Boutons d'une notification (lot 8). Le panel décide ICI — dans du code testé — quels gestes une
 * notification propose et vers quelle route ils pointent ; le service worker ne fait qu'exécuter.
 *
 * Seuls les cas où l'on sait quoi faire en méritent : un serveur tombé (le relancer, ou ouvrir sa
 * console) et un démarrage qui a échoué (la console, parce qu'il faut d'abord LIRE). Ailleurs, le
 * clic ouvre la page, ce qui est déjà l'essentiel.
 *
 * L'action ne contourne aucun droit : la route appelée est celle du panel, avec le cookie de la
 * session, et un lecteur reçoit le même refus que dans l'interface.
 */
export function pushActionsFor(event: EventDto, t: (key: string) => string): PushAction[] {
  if (event.serverId === null) return [];
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const down =
    (event.type === 'server.stateChanged' && p.state === 'crashed') ||
    (event.type === 'alert.firing' && p.rule === 'server.down');
  const consoleAction: PushAction = {
    action: 'console',
    title: t('common:notify.actions.console'),
    url: `/servers/${event.serverId}?tab=console`,
  };
  if (down) {
    return [
      {
        action: 'restart',
        title: t('common:notify.actions.start'),
        url: `/api/servers/${event.serverId}/start`,
        method: 'POST',
        okBody: t('common:notify.actions.started'),
        failBody: t('common:notify.actions.failed'),
      },
      consoleAction,
    ];
  }
  return event.type === 'server.startFailed' ? [consoleAction] : [];
}

export function notifyKey(event: EventDto): string | undefined {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  switch (event.type) {
    case 'server.stateChanged':
      return p.state === 'crashed'
        ? 'serverCrashed'
        : p.state === 'running'
          ? 'serverRunning'
          : p.state === 'stopped'
            ? 'serverStopped'
            : undefined;
    case 'server.startFailed':
      return 'serverStartFailed';
    case 'watchdog.alert':
      return 'watchdogAlert';
    case 'agent.offline':
      return 'agentOffline';
    // Lot 4 : une copie hors-site (`backup.receive`) a son propre libellé — « sauvegarde échouée »
    // ferait croire que l'archive elle-même manque.
    case 'task.failed':
      return p.kind === 'backup.receive'
        ? 'replicaFailed'
        : typeof p.kind === 'string' && p.kind.startsWith('backup.')
          ? 'backupFailed'
          : 'taskFailed';
    case 'task.completed':
      return p.kind === 'backup.receive'
        ? 'replicaDone'
        : typeof p.kind === 'string' && p.kind.startsWith('backup.')
          ? 'backupDone'
          : 'taskDone';
    // Une duplication emprunte les événements de migration (`payload.kind`), pas leur libellé.
    case 'migration.done':
      return p.kind === 'duplicate' ? 'duplicationDone' : 'migrationDone';
    case 'migration.failed':
      return p.kind === 'duplicate' ? 'duplicationFailed' : 'migrationFailed';
    case 'agent.updateApplied':
      return 'agentUpdateApplied';
    case 'agent.updateRolledBack':
      return 'agentUpdateRolledBack';
    case 'panel.updateAvailable':
      return 'panelUpdateAvailable';
    case 'panel.backupFailed':
      return 'panelBackupFailed';
    // Lot 4 : santé des webhooks sortants ; `webhook.test` n'est jamais publié sur le bus, il est
    // rendu par le service webhooks pour le bouton « Tester ».
    case 'webhook.failed':
      return 'webhookFailed';
    case 'webhook.recovered':
      return 'webhookRecovered';
    case 'webhook.test':
      return 'webhookTest';
    case 'schedule.run':
      return event.severity === 'info' ? 'scheduleDone' : 'scheduleFailed';
    case 'port.conflict':
      return 'portConflict';
    case 'player.joined':
      return 'playerJoined';
    case 'player.left':
      return 'playerLeft';
    case 'backup.overdue':
      return 'backupOverdue';
    case 'backup.corrupted':
      return 'backupCorrupted';
    // Le message vient de l'agent, en anglais technique : il est repris tel quel dans le corps
    // plutôt que traduit — c'est lui qui nomme le fichier ou le compte en cause.
    case 'agent.log':
      return 'agentProblem';
    case 'machine.paired':
      return 'machinePaired';
    case 'server.adopted':
      return 'serverDiscovered';
    case 'server.removed':
      return 'serverGone';
    case 'server.deleted':
      return 'serverDeleted';
    case 'server.migrated':
      return 'serverMoved';
    case 'server.conflict':
      return 'serverConflict';
    case 'player.action':
      return 'playerAction';
    // Lot 8 : un ami a demandé la liste blanche depuis la page publique. Le mot qu'il a laissé
    // n'est PAS dans l'événement (il se lit dans le panel) : seul le pseudo, contraint, est cité.
    case 'whitelist.requested':
      return 'whitelistRequested';
    // Une seule famille d'événements pour toutes les alertes : la règle choisit le libellé.
    case 'alert.firing': {
      const rule = (event.payload as { rule?: unknown } | undefined)?.rule;
      return rule === 'machine.offline'
        ? 'alertMachineOffline'
        : rule === 'server.down'
          ? 'alertServerDown'
          : rule === 'disk.low'
            ? 'alertDiskLow'
            : rule === 'tps.low'
              ? 'alertTpsLow'
              : undefined;
    }
    case 'alert.resolved':
      return 'alertResolved';
    default:
      return undefined;
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
}

function shortEndpoint(endpoint: string): string {
  try {
    const u = new URL(endpoint);
    return `${u.host}${u.pathname.slice(0, 24)}…`;
  } catch {
    return endpoint.slice(0, 40);
  }
}

function toSubscriptionDto(row: typeof pushSubscriptions.$inferSelect): PushSubscriptionDto {
  return {
    id: row.id,
    endpoint: shortEndpoint(row.endpoint),
    userAgent: row.userAgent,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    lastSuccessAt: row.lastSuccessAt,
    failCount: row.failCount,
  };
}
