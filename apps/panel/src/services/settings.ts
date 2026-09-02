/** `app_settings` clé/valeur (doc 04 §6). Les clés secrètes ne sortent jamais par l'API. */
import { eq } from 'drizzle-orm';

import { isValidTimeZone, localTimeZone } from '@mmo/shared';

import type { MmoDatabase } from '../db/client.js';
import { appSettings } from '../db/schema.js';

export const SETTING_KEYS = {
  publicUrl: 'panel.publicUrl',
  accessMode: 'access.mode',
  backupDestination: 'backups.defaultDestination',
  /** Recette 1.0 : rattrapage unique des politiques de sauvegarde par défaut ('1' = fait). */
  backupDefaultsSeeded: 'backups.defaultsSeeded',
  /**
   * Fuseau dans lequel TOUTES les planifications sont lues (sauvegardes et actions programmées).
   * Sans lui, chaque processus évaluait dans le sien — un agent Linux en UTC faisait partir à 6 h
   * une sauvegarde réglée sur 4 h par un utilisateur à Paris, sans que rien ne le dise.
   */
  scheduleTimezone: 'schedule.timezone',
  /**
   * Rétentions (jours, entiers ≥ 1) appliquées par la maintenance horaire (doc 04 §8.6). Lot 9 :
   * `command_history`, `player_sessions`, migrations et sauvegardes supprimées n'étaient bornées
   * par rien ; `tasks` l'était par une constante.
   */
  eventsRetentionDays: 'retention.eventsDays',
  auditRetentionDays: 'retention.auditDays',
  uiEventsRetentionDays: 'retention.uiEventsDays',
  commandHistoryRetentionDays: 'retention.commandHistoryDays',
  playerSessionsRetentionDays: 'retention.playerSessionsDays',
  migrationsRetentionDays: 'retention.migrationsDays',
  deletedBackupsRetentionDays: 'retention.deletedBackupsDays',
  tasksRetentionDays: 'retention.tasksDays',
  /** Horodatage du dernier VACUUM hebdomadaire (persisté : un redémarrage ne relance pas la semaine). */
  vacuumAt: 'maintenance.vacuumAt',
  /**
   * Vie privée (lot 9) : les deux appels sortants qui parlent des joueurs — l'API Mojang (par
   * l'agent, pseudo → UUID en mode en ligne) et les avatars mc-heads.net (par le navigateur).
   */
  mojangLookup: 'privacy.mojangLookup',
  externalAvatars: 'privacy.externalAvatars',
  restoreOnBoot: 'agents.restoreOnBoot',
  metricsIntervalSec: 'metrics.intervalSec',
  /** Phase 9 : mise à jour automatique des agents à la connexion. */
  autoUpdate: 'agents.autoUpdate',
  /** Lot 2 : bannière « version X disponible » (releases.atom GitHub, au plus 1 fois/6 h). */
  updateCheckEnabled: 'panel.updateCheck.enabled',
  updateCheckedAt: 'panel.update.checkedAt',
  updateLatestVersion: 'panel.update.latestVersion',
  updateNotifiedVersion: 'panel.update.notifiedVersion',
  vapidPublicKey: 'push.vapidPublicKey',
  vapidPrivateKey: 'push.vapidPrivateKey',
  setupCompletedAt: 'setup.completedAt',
  /** Phase 10 : couche d'accès (doc 03 §5). */
  accessDomain: 'access.domain',
  accessHttpsPort: 'access.httpsPort',
  dnsProvider: 'access.dns.provider',
  dnsToken: 'access.dns.token',
  dnsZone: 'access.dns.zone',
  dnsUpdateUrl: 'access.dns.updateUrl',
  acmeEmail: 'access.acme.email',
  acmeDirectory: 'access.acme.directory',
  dyndnsEnabled: 'access.dyndns.enabled',
  accessPublicHost: 'access.publicHost',
  /**
   * Lot 2 : voie « direct » activée EN PLUS du mode courant (une machine passe par Tailscale, une
   * autre par l'accès direct — le panel répond sur les deux voies à la fois).
   */
  accessDirectEnabled: 'access.direct.enabled',
} as const;

/** Jamais renvoyées par l API ni écrites dans un rapport de diagnostic (une 2e liste divergerait). */
export const SECRET_KEYS: ReadonlySet<string> = new Set([
  SETTING_KEYS.vapidPrivateKey,
  SETTING_KEYS.dnsToken,
]);

const DEFAULTS: Readonly<Record<string, string>> = {
  [SETTING_KEYS.accessMode]: 'tailscale',
  [SETTING_KEYS.eventsRetentionDays]: '90',
  [SETTING_KEYS.auditRetentionDays]: '365',
  [SETTING_KEYS.uiEventsRetentionDays]: '14',
  [SETTING_KEYS.commandHistoryRetentionDays]: '90',
  [SETTING_KEYS.playerSessionsRetentionDays]: '365',
  [SETTING_KEYS.migrationsRetentionDays]: '90',
  [SETTING_KEYS.deletedBackupsRetentionDays]: '30',
  [SETTING_KEYS.tasksRetentionDays]: '30',
  [SETTING_KEYS.mojangLookup]: 'true',
  [SETTING_KEYS.externalAvatars]: 'true',
  [SETTING_KEYS.restoreOnBoot]: 'true',
  [SETTING_KEYS.metricsIntervalSec]: '15',
  [SETTING_KEYS.accessHttpsPort]: '443',
  [SETTING_KEYS.dnsProvider]: 'manual',
  [SETTING_KEYS.dyndnsEnabled]: 'false',
  [SETTING_KEYS.updateCheckEnabled]: 'true',
  [SETTING_KEYS.accessDirectEnabled]: 'false',
};

export class SettingsService {
  constructor(
    private readonly db: MmoDatabase,
    private readonly now: () => number,
  ) {}

  get(key: string): string | undefined {
    const row = this.db.select().from(appSettings).where(eq(appSettings.key, key)).get();
    return row?.value ?? DEFAULTS[key];
  }

  getBool(key: string): boolean {
    const v = this.get(key);
    return v === 'true' || v === '1';
  }

  getInt(key: string, fallback: number): number {
    const v = Number(this.get(key));
    return Number.isFinite(v) ? v : fallback;
  }

  /**
   * Entier ≥ 1 (rétentions en jours). Une valeur absente, non numérique ou nulle retombe sur le
   * défaut de la clé : « 0 jour » viderait la table entière à la prochaine maintenance.
   */
  positiveInt(key: string): number {
    const parse = (raw: string | undefined): number | undefined => {
      const v = Number(raw);
      return Number.isInteger(v) && v >= 1 ? v : undefined;
    };
    return parse(this.get(key)) ?? parse(DEFAULTS[key]) ?? 1;
  }

  set(key: string, value: string): void {
    this.db
      .insert(appSettings)
      .values({ key, value, updatedAt: this.now() })
      .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: this.now() } })
      .run();
  }

  /**
   * Fuseau des planifications : celui réglé, sinon celui de l'hôte du panel. Un nom devenu
   * invalide (base IANA amputée, réglage bricolé à la main) ne doit pas figer le planificateur :
   * on retombe sur l'hôte plutôt que de lever.
   */
  timeZone(): string {
    const stored = this.get(SETTING_KEYS.scheduleTimezone);
    return stored !== undefined && isValidTimeZone(stored) ? stored : localTimeZone();
  }

  /** Toutes les clés non secrètes (défauts inclus). */
  public(): Record<string, string> {
    const out: Record<string, string> = {
      ...DEFAULTS,
      [SETTING_KEYS.scheduleTimezone]: this.timeZone(),
    };
    for (const row of this.db.select().from(appSettings).all()) {
      if (!SECRET_KEYS.has(row.key)) out[row.key] = row.value;
      // Un secret n'est jamais renvoyé, mais l'UI doit savoir s'il est renseigné.
      else out[`${row.key}.set`] = row.value === '' ? 'false' : 'true';
    }
    return out;
  }
}
