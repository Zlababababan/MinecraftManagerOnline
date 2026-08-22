/**
 * Watchdog local (doc 06 §4, doc 05 §6) — exécuté par l'agent, panel éteint ou non :
 *  - **crash** : état `crashed` émis par `ServerProcess` (faisceau : exit sans arrêt demandé, rapport
 *    `crash-reports/`, patterns de log) → `watchdog.alert` + auto-restart optionnel, borné par
 *    `crashLoopMax` redémarrages par fenêtre glissante (défaut 10 min), délai croissant ;
 *  - **freeze** : sonde RCON `list` périodique (timeout 5 s) ; 3 échecs consécutifs, processus
 *    vivant ⇒ alerte + action `none` | `kill_restart` (exit classé `freeze_kill`, compte comme crash) ;
 *  - **RAM** : RSS très au-dessus de `maxRamMb` (collecteur de métriques) ⇒ alerte `ram`, une fois ;
 *  - **ports** : `FAILED TO BIND TO PORT` ou `E_PORT_IN_USE` au redémarrage ⇒ `port.conflict`.
 * La politique par serveur est poussée par `agent.configure.watchdog` et persistée dans l'état.
 */
import type { EventPayload, RunState } from '@mmo/protocol';

import { errorMessage, type Logger } from '../log.js';

export interface WatchdogPolicy {
  autoRestart: boolean;
  crashLoopMax: number;
  freezeTimeoutSec: number;
  freezeAction: 'none' | 'kill_restart';
}

export type WatchdogAlert = Omit<EventPayload<'watchdog.alert'>, 'eventId'>;

export interface WatchdogServerView {
  /** État courant (lu à chaque appel : la sonde traverse des `await`). */
  state: () => RunState;
  pid: number | undefined;
  /** Sonde de vivacité (RCON `list`) ; `undefined` si RCON indisponible. */
  probe: ((timeoutMs: number) => Promise<void>) | undefined;
  alive: () => boolean;
  kill: (reason: 'freeze') => Promise<unknown>;
}

export interface WatchdogOptions {
  logger: Logger;
  policy: (serverId: string) => WatchdogPolicy | undefined;
  view: (serverId: string) => WatchdogServerView | undefined;
  /** Relance (garde-fous inclus : RAM, port, EULA, Java). */
  restart: (serverId: string) => Promise<unknown>;
  alert: (alert: WatchdogAlert) => void;
  /** Fenêtre de comptage des redémarrages automatiques (défaut 10 min). */
  crashWindowMs?: number;
  /** Délai avant relance : `min(base × tentative, max)` (défauts 5 s / 60 s). */
  restartDelayMs?: number;
  restartDelayMaxMs?: number;
  /** Bornes de l'intervalle de sonde (défaut 5 s … 60 s ; `freezeTimeoutSec / 3` entre les deux). */
  minProbeIntervalMs?: number;
  maxProbeIntervalMs?: number;
  probeTimeoutMs?: number;
  freezeFailures?: number;
  now?: () => number;
}

interface ServerState {
  crashes: number[];
  restartTimer: ReturnType<typeof setTimeout> | undefined;
  probeTimer: ReturnType<typeof setInterval> | undefined;
  probing: boolean;
  failures: number;
  freezeAlerted: boolean;
  ramAlerted: boolean;
}

export class Watchdog {
  private readonly servers = new Map<string, ServerState>();

  constructor(private readonly options: WatchdogOptions) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private state(serverId: string): ServerState {
    let s = this.servers.get(serverId);
    if (!s) {
      s = {
        crashes: [],
        restartTimer: undefined,
        probeTimer: undefined,
        probing: false,
        failures: 0,
        freezeAlerted: false,
        ramAlerted: false,
      };
      this.servers.set(serverId, s);
    }
    return s;
  }

  /** Tentatives de redémarrage automatique dans la fenêtre courante. */
  attempts(serverId: string): number {
    const s = this.servers.get(serverId);
    if (!s) return 0;
    const since = this.now() - (this.options.crashWindowMs ?? 600_000);
    s.crashes = s.crashes.filter((t) => t >= since);
    return s.crashes.length;
  }

  /** Arrêt demandé explicitement : annule une relance en attente et remet les compteurs à zéro. */
  cancel(serverId: string): void {
    const s = this.servers.get(serverId);
    if (!s) return;
    if (s.restartTimer !== undefined) clearTimeout(s.restartTimer);
    s.restartTimer = undefined;
    s.crashes = [];
    this.stopProbe(s);
  }

  /** Transition d'état d'un serveur (depuis `server.stateChanged` local). */
  onStateChanged(
    serverId: string,
    state: RunState,
    extra: { exitReason?: string; crashReportPath?: string; crashSignal?: string } = {},
  ): void {
    const s = this.state(serverId);
    switch (state) {
      case 'starting':
        s.failures = 0;
        s.freezeAlerted = false;
        s.ramAlerted = false;
        this.stopProbe(s);
        break;
      case 'running':
        s.failures = 0;
        s.freezeAlerted = false;
        this.startProbe(serverId, s);
        break;
      case 'stopping':
        this.stopProbe(s);
        break;
      case 'stopped':
        this.stopProbe(s);
        s.crashes = [];
        break;
      case 'crashed':
        this.stopProbe(s);
        this.onCrash(serverId, s, extra);
        break;
    }
  }

  /** Garde-fou RAM (depuis le collecteur de métriques). */
  onRamExceeded(serverId: string, rssMb: number, maxRamMb: number): void {
    const s = this.state(serverId);
    if (s.ramAlerted) return;
    s.ramAlerted = true;
    this.options.alert({
      serverId,
      ts: this.now(),
      kind: 'ram',
      action: 'none',
      attempt: 0,
      detail: `rss ${String(rssMb)} MB > ${String(maxRamMb)} MB (maxRamMb)`,
    });
  }

  dispose(): void {
    for (const [, s] of this.servers) {
      if (s.restartTimer !== undefined) clearTimeout(s.restartTimer);
      s.restartTimer = undefined;
      this.stopProbe(s);
    }
  }

  // --- Crash ------------------------------------------------------------------------------------

  private onCrash(
    serverId: string,
    s: ServerState,
    extra: { exitReason?: string; crashReportPath?: string; crashSignal?: string },
  ): void {
    const policy = this.options.policy(serverId);
    const ts = this.now();
    const details: string[] = [];
    if (extra.exitReason === 'freeze_kill') details.push('freeze_kill');
    if (extra.crashSignal !== undefined) details.push(extra.crashSignal);
    if (extra.crashReportPath !== undefined) details.push(extra.crashReportPath);
    const detail = details.length === 0 ? undefined : details.join(' · ');
    if (!policy?.autoRestart) {
      this.options.alert({
        serverId,
        ts,
        kind: 'crash',
        action: 'none',
        attempt: 0,
        ...(detail === undefined ? {} : { detail }),
      });
      return;
    }
    const attempts = this.attempts(serverId);
    if (attempts >= policy.crashLoopMax) {
      this.options.logger.warn('crash loop: giving up', { serverId, attempts });
      this.options.alert({
        serverId,
        ts,
        kind: 'crash_loop',
        action: 'gave_up',
        attempt: attempts,
        ...(detail === undefined ? {} : { detail }),
      });
      s.crashes = [];
      return;
    }
    const attempt = attempts + 1;
    s.crashes.push(ts);
    this.options.alert({
      serverId,
      ts,
      kind: 'crash',
      action: 'restart',
      attempt,
      ...(detail === undefined ? {} : { detail }),
    });
    const delay = Math.min(
      (this.options.restartDelayMs ?? 5000) * attempt,
      this.options.restartDelayMaxMs ?? 60_000,
    );
    if (s.restartTimer !== undefined) clearTimeout(s.restartTimer);
    s.restartTimer = setTimeout(() => {
      s.restartTimer = undefined;
      this.options.logger.info('auto-restart', { serverId, attempt });
      this.options.restart(serverId).catch((error: unknown) => {
        this.options.logger.warn('auto-restart failed', { serverId, error: errorMessage(error) });
      });
    }, delay);
    s.restartTimer.unref();
  }

  // --- Freeze -----------------------------------------------------------------------------------

  private startProbe(serverId: string, s: ServerState): void {
    this.stopProbe(s);
    const policy = this.options.policy(serverId);
    const view = this.options.view(serverId);
    if (!policy || !view?.probe) return;
    const min = this.options.minProbeIntervalMs ?? 5000;
    const max = this.options.maxProbeIntervalMs ?? 60_000;
    const interval = Math.max(min, Math.min(max, Math.round((policy.freezeTimeoutSec * 1000) / 3)));
    s.probeTimer = setInterval(() => {
      void this.probe(serverId, s, interval);
    }, interval);
    s.probeTimer.unref();
  }

  private stopProbe(s: ServerState): void {
    if (s.probeTimer !== undefined) clearInterval(s.probeTimer);
    s.probeTimer = undefined;
    s.probing = false;
  }

  private async probe(serverId: string, s: ServerState, interval: number): Promise<void> {
    if (s.probing) return;
    const view = this.options.view(serverId);
    const policy = this.options.policy(serverId);
    if (!view?.probe || !policy || view.state() !== 'running') return;
    s.probing = true;
    try {
      await view.probe(Math.min(this.options.probeTimeoutMs ?? 5000, interval));
      s.failures = 0;
      s.freezeAlerted = false;
    } catch (error) {
      if (!view.alive() || view.state() !== 'running') return;
      s.failures += 1;
      this.options.logger.debug('liveness probe failed', {
        serverId,
        failures: s.failures,
        error: errorMessage(error),
      });
      if (s.failures >= (this.options.freezeFailures ?? 3) && !s.freezeAlerted) {
        s.freezeAlerted = true;
        await this.onFreeze(serverId, s, view, policy);
      }
    } finally {
      s.probing = false;
    }
  }

  private async onFreeze(
    serverId: string,
    s: ServerState,
    view: WatchdogServerView,
    policy: WatchdogPolicy,
  ): Promise<void> {
    const detail = `${String(s.failures)} consecutive rcon probe failures`;
    this.options.logger.warn('freeze suspected', { serverId, action: policy.freezeAction });
    this.options.alert({
      serverId,
      ts: this.now(),
      kind: 'freeze',
      action: policy.freezeAction,
      attempt: policy.freezeAction === 'kill_restart' ? this.attempts(serverId) + 1 : 0,
      detail,
    });
    if (policy.freezeAction !== 'kill_restart') return;
    this.stopProbe(s);
    try {
      // L'exit sera classé `crashed` / `freeze_kill` → `onCrash` décide de la relance (bornée).
      await view.kill('freeze');
    } catch (error) {
      this.options.logger.warn('freeze kill failed', { serverId, error: errorMessage(error) });
    }
  }
}
