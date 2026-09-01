/**
 * Bannière « version X disponible » (lot 2) : lecture du flux `releases.atom` du dépôt GitHub —
 * pas d'API, pas de quota — au plus une fois par 6 h, accrochée au tick de maintenance horaire.
 * Le service s'auto-limite via `panel.update.checkedAt` (patron `panelBackup.backupIfStale`),
 * cache la dernière version en `app_settings`, et publie `panel.updateAvailable` UNE fois par
 * version découverte (centre de notifications + push via la catégorie `panel.update`).
 * `panel.updateCheck.enabled` (défaut activé) coupe tout : un panel auto-hébergé ne doit pas être
 * forcé de parler à GitHub.
 */
import { compareVersions } from '@mmo/shared';

import { PANEL_VERSION } from '../version.js';
import type { PublishInput } from './events.js';
import { SETTING_KEYS, type SettingsService } from './settings.js';

export const UPDATE_CHECK_INTERVAL_MS = 6 * 3_600_000;
const DEFAULT_ATOM_URL = 'https://github.com/Zlababababan/MinecraftManagerOnline/releases.atom';

interface UpdateCheckDeps {
  settings: SettingsService;
  events: { publish: (input: PublishInput) => unknown };
  now: () => number;
  fetchImpl: typeof fetch | undefined;
  /** Tests : flux et version courante substituables. */
  atomUrl?: string;
  currentVersion?: string;
}

export class UpdateCheckService {
  constructor(private readonly deps: UpdateCheckDeps) {}

  private current(): string {
    return this.deps.currentVersion ?? PANEL_VERSION;
  }

  /** Dernière version amont connue strictement plus récente que la version courante. */
  latestAvailable(): string | undefined {
    const latest = this.deps.settings.get(SETTING_KEYS.updateLatestVersion);
    return latest !== undefined && compareVersions(latest, this.current()) > 0 ? latest : undefined;
  }

  /** Appelé à chaque tick de maintenance ; ne sort sur le réseau qu'une fois par 6 h. */
  async checkIfStale(): Promise<void> {
    if (!this.deps.settings.getBool(SETTING_KEYS.updateCheckEnabled)) return;
    const now = this.deps.now();
    const checkedAt = Number(this.deps.settings.get(SETTING_KEYS.updateCheckedAt) ?? 0);
    if (Number.isFinite(checkedAt) && now - checkedAt < UPDATE_CHECK_INTERVAL_MS) return;
    // Horodaté AVANT l'appel : un GitHub en panne ne se fait pas marteler à chaque tick horaire.
    this.deps.settings.set(SETTING_KEYS.updateCheckedAt, String(now));
    const doFetch = this.deps.fetchImpl ?? fetch;
    const res = await doFetch(this.deps.atomUrl ?? DEFAULT_ATOM_URL, {
      signal: AbortSignal.timeout(10_000),
      headers: { accept: 'application/atom+xml' },
    });
    if (!res.ok) throw new Error(`releases.atom: HTTP ${String(res.status)}`);
    const latest = latestReleaseIn(await res.text());
    if (latest === undefined) return;
    this.deps.settings.set(SETTING_KEYS.updateLatestVersion, latest);
    if (compareVersions(latest, this.current()) <= 0) return;
    if (this.deps.settings.get(SETTING_KEYS.updateNotifiedVersion) === latest) return;
    this.deps.settings.set(SETTING_KEYS.updateNotifiedVersion, latest);
    this.deps.events.publish({
      type: 'panel.updateAvailable',
      severity: 'info',
      payload: { version: latest, current: this.current() },
      ts: now,
    });
  }
}

/**
 * Le flux Atom liste TOUTES les releases (pré-releases comprises — 1.0.2/1.0.3 y figurent
 * toujours) et les titres sont libres (« 1.0.5 — no compiler… ») : on lit les tags des liens
 * `/releases/tag/vX.Y.Z`, on ignore tout suffixe de pré-release (le garde de fin de chaîne les
 * exclut), et on prend le MAX — l'ordre du flux est chronologique, pas sémantique.
 */
export function latestReleaseIn(atom: string): string | undefined {
  let latest: string | undefined;
  for (const match of atom.matchAll(/\/releases\/tag\/v?(\d+\.\d+\.\d+)(?=["'<])/g)) {
    const version = match[1];
    if (version !== undefined && (latest === undefined || compareVersions(version, latest) > 0)) {
      latest = version;
    }
  }
  return latest;
}
