/**
 * Sonde TPS/MSPT par serveur (doc 06 §6) : chaîne de fallback `neoforge tps` → `forge tps` →
 * `spark tps` (si spark dans `mods/`) → `tick query` (MC ≥ 1.20.3) → « indisponible », exécutée
 * via RCON. La méthode qui répond est mémorisée.
 *
 * Deux causes d'échec, deux traitements — la confusion des deux était un vrai bug produit, masqué
 * en CI par une tolérance `[flaky-ci]` :
 *   - **non supportée** : le serveur a RÉPONDU mais ne connaît pas la commande. Insister
 *     spammerait sa console → verrou long (`retryAfterMs`, 10 min par défaut).
 *   - **transport** : RCON n'a pas répondu (listener pas encore ouvert, socket coupé, timeout).
 *     La commande n'y est pour rien → réessai après un backoff court et croissant, la méthode
 *     apprise est conservée, et le passage du serveur à `running` débloque immédiatement.
 * Avant, tout échec armait le verrou de 10 minutes : sur un runner lent, un seul ECONNREFUSED au
 * démarrage suffisait à ce que le TPS ne soit plus jamais échantillonné de toute la session.
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { isProtocolError, type TpsSource } from '@mmo/protocol';
import { parseTpsResponse, tpsChain, type TpsMethod, type TpsReading } from '@mmo/shared';

export interface TpsProbeOptions {
  serverDir: string;
  loader: 'vanilla' | 'forge' | 'neoforge' | 'fabric' | 'unknown' | undefined;
  mcVersion: string | undefined;
  exec: (command: string, timeoutMs: number) => Promise<string>;
  timeoutMs?: number;
  /** Verrou long quand le serveur répond mais ne connaît aucune commande (défaut 10 min). */
  retryAfterMs?: number;
  /** Premier délai après un échec de transport, doublé ensuite (défaut 5 s, plafond 60 s). */
  transportRetryBaseMs?: number;
  now?: () => number;
  log?: (message: string, data?: Record<string, unknown>) => void;
}

export interface TpsResult extends TpsReading {
  source: TpsSource;
}

/** Au-delà, on cesse de sonder court : serveur sans RCON, mot de passe faux, RCON désactivé… */
const MAX_TRANSPORT_FAILURES = 20;
const TRANSPORT_RETRY_CAP_MS = 60_000;

type Attempt =
  | { kind: 'ok'; reading: TpsReading }
  | { kind: 'unsupported' }
  | { kind: 'transport'; reason: string };

export async function detectSpark(serverDir: string): Promise<boolean> {
  try {
    const names = await readdir(path.join(serverDir, 'mods'));
    return names.some((n) => /^spark-.*\.jar$/i.test(n));
  } catch {
    return false;
  }
}

export class TpsProbe {
  private chain: TpsMethod[] | undefined;
  private working: TpsMethod | undefined;
  private unavailableUntil = 0;
  private transportFailures = 0;
  private lockedWarned = false;

  constructor(private readonly options: TpsProbeOptions) {}

  /** Méthode ayant répondu la dernière fois (pour l'affichage), `undefined` si aucune. */
  get source(): TpsSource | undefined {
    return this.working?.source;
  }

  /** Oublie l'état appris (nouveau démarrage du serveur : mods changés, version…). */
  reset(): void {
    this.chain = undefined;
    this.working = undefined;
    this.unavailableUntil = 0;
    this.transportFailures = 0;
    this.lockedWarned = false;
  }

  /**
   * Le serveur vient d'annoncer qu'il tourne : RCON est probablement joignable. Lève le verrou
   * sans jeter la chaîne apprise (contrairement à `reset()`, qui relit `mods/` et repart de la
   * première commande — donc écrit « Unknown or incomplete command » dans la console).
   */
  unlock(): void {
    this.unavailableUntil = 0;
    this.transportFailures = 0;
  }

  async read(): Promise<TpsResult | undefined> {
    const now = this.options.now?.() ?? Date.now();
    if (now < this.unavailableUntil) return undefined;
    const chain = await this.ensureChain();
    if (chain.length === 0) {
      this.unavailableUntil = now + this.longRetryMs();
      return undefined;
    }
    // La méthode qui a déjà répondu d'abord : la chaîne complète n'est déroulée qu'à la découverte.
    const ordered = this.working
      ? [this.working, ...chain.filter((m) => m !== this.working)]
      : chain;
    for (const method of ordered) {
      const attempt = await this.tryMethod(method);
      if (attempt.kind === 'ok') {
        this.working = method;
        this.transportFailures = 0;
        this.lockedWarned = false;
        return { ...attempt.reading, source: method.source };
      }
      if (attempt.kind === 'transport') {
        // Le tuyau est le même pour toutes les méthodes : inutile de dérouler la suite de la
        // chaîne, ce serait N échecs identiques et autant de bruit.
        this.onTransportFailure(now, method, attempt.reason);
        return undefined;
      }
    }
    // Toutes les méthodes ont répondu sans être comprises : ce serveur n'en connaît aucune.
    this.working = undefined;
    this.unavailableUntil = now + this.longRetryMs();
    this.warnOnce('tps unavailable: no supported command on this server');
    return undefined;
  }

  private longRetryMs(): number {
    return this.options.retryAfterMs ?? 600_000;
  }

  private onTransportFailure(now: number, method: TpsMethod, reason: string): void {
    this.transportFailures += 1;
    // `working` est conservé : c'est le transport qui a lâché, pas la commande apprise.
    if (this.transportFailures >= MAX_TRANSPORT_FAILURES) {
      this.unavailableUntil = now + this.longRetryMs();
      this.warnOnce(`tps unavailable: rcon unreachable (${reason})`);
      return;
    }
    const base = this.options.transportRetryBaseMs ?? 5_000;
    const delay = Math.min(base * 2 ** (this.transportFailures - 1), TRANSPORT_RETRY_CAP_MS);
    this.unavailableUntil = now + delay;
    this.options.log?.('tps read failed (transport)', {
      command: method.command,
      reason,
      attempt: this.transportFailures,
      retryInMs: delay,
    });
  }

  private warnOnce(message: string): void {
    if (this.lockedWarned) return;
    this.lockedWarned = true;
    this.options.log?.(message);
  }

  private async ensureChain(): Promise<TpsMethod[]> {
    this.chain ??= tpsChain({
      loader: this.options.loader,
      mcVersion: this.options.mcVersion,
      sparkInstalled: await detectSpark(this.options.serverDir),
    });
    return this.chain;
  }

  /**
   * Classe l'issue. Une exception d'`exec` = transport, SAUF `E_INVALID_PAYLOAD` (commande trop
   * longue : défaut permanent de la méthode, donc « non supportée »). Une réponse reçue mais
   * illisible = « non supportée », c'est le seul cas où insister spammerait la console.
   */
  private async tryMethod(method: TpsMethod): Promise<Attempt> {
    let response: string;
    try {
      response = await this.options.exec(method.command, this.options.timeoutMs ?? 5000);
    } catch (error) {
      if (isProtocolError(error) && error.code === 'E_INVALID_PAYLOAD')
        return { kind: 'unsupported' };
      return {
        kind: 'transport',
        reason: isProtocolError(error) ? error.code : (error as Error).message,
      };
    }
    const reading = parseTpsResponse(method.source, response);
    if (!reading || (reading.tps === undefined && reading.mspt === undefined)) {
      return { kind: 'unsupported' };
    }
    return { kind: 'ok', reading };
  }
}
