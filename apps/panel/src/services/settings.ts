/** `app_settings` clé/valeur (doc 04 §6). Les clés secrètes ne sortent jamais par l'API. */
import { eq } from 'drizzle-orm';

import type { MmoDatabase } from '../db/client.js';
import { appSettings } from '../db/schema.js';

export const SETTING_KEYS = {
  publicUrl: 'panel.publicUrl',
  accessMode: 'access.mode',
  backupDestination: 'backups.defaultDestination',
  eventsRetentionDays: 'retention.eventsDays',
  auditRetentionDays: 'retention.auditDays',
  restoreOnBoot: 'agents.restoreOnBoot',
  metricsIntervalSec: 'metrics.intervalSec',
  /** Phase 9 : mise à jour automatique des agents à la connexion. */
  autoUpdate: 'agents.autoUpdate',
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
} as const;

const SECRET_KEYS: ReadonlySet<string> = new Set([
  SETTING_KEYS.vapidPrivateKey,
  SETTING_KEYS.dnsToken,
]);

const DEFAULTS: Readonly<Record<string, string>> = {
  [SETTING_KEYS.accessMode]: 'tailscale',
  [SETTING_KEYS.eventsRetentionDays]: '90',
  [SETTING_KEYS.auditRetentionDays]: '365',
  [SETTING_KEYS.restoreOnBoot]: 'true',
  [SETTING_KEYS.metricsIntervalSec]: '15',
  [SETTING_KEYS.accessHttpsPort]: '443',
  [SETTING_KEYS.dnsProvider]: 'manual',
  [SETTING_KEYS.dyndnsEnabled]: 'false',
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

  set(key: string, value: string): void {
    this.db
      .insert(appSettings)
      .values({ key, value, updatedAt: this.now() })
      .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: this.now() } })
      .run();
  }

  /** Toutes les clés non secrètes (défauts inclus). */
  public(): Record<string, string> {
    const out: Record<string, string> = { ...DEFAULTS };
    for (const row of this.db.select().from(appSettings).all()) {
      if (!SECRET_KEYS.has(row.key)) out[row.key] = row.value;
      // Un secret n'est jamais renvoyé, mais l'UI doit savoir s'il est renseigné.
      else out[`${row.key}.set`] = row.value === '' ? 'false' : 'true';
    }
    return out;
  }
}
