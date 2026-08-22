/**
 * Sonde TPS/MSPT par serveur (doc 06 §6) : chaîne de fallback `neoforge tps` → `forge tps` →
 * `spark tps` (si spark dans `mods/`) → `tick query` (MC ≥ 1.20.3) → « indisponible », exécutée
 * via RCON. La méthode qui répond est mémorisée ; quand toute la chaîne échoue, on n'insiste pas
 * avant `retryAfterMs` (défaut 10 min) pour ne pas spammer la console du serveur.
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';

import type { TpsSource } from '@mmo/protocol';
import { parseTpsResponse, tpsChain, type TpsMethod, type TpsReading } from '@mmo/shared';

export interface TpsProbeOptions {
  serverDir: string;
  loader: 'vanilla' | 'forge' | 'neoforge' | 'fabric' | 'unknown' | undefined;
  mcVersion: string | undefined;
  exec: (command: string, timeoutMs: number) => Promise<string>;
  timeoutMs?: number;
  retryAfterMs?: number;
  now?: () => number;
}

export interface TpsResult extends TpsReading {
  source: TpsSource;
}

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
  }

  async read(): Promise<TpsResult | undefined> {
    const now = this.options.now?.() ?? Date.now();
    if (now < this.unavailableUntil) return undefined;
    const chain = await this.ensureChain();
    if (chain.length === 0) {
      this.unavailableUntil = now + (this.options.retryAfterMs ?? 600_000);
      return undefined;
    }
    const ordered = this.working
      ? [this.working, ...chain.filter((m) => m !== this.working)]
      : chain;
    for (const method of ordered) {
      const reading = await this.tryMethod(method);
      if (reading) {
        this.working = method;
        return { ...reading, source: method.source };
      }
    }
    this.working = undefined;
    this.unavailableUntil = now + (this.options.retryAfterMs ?? 600_000);
    return undefined;
  }

  private async ensureChain(): Promise<TpsMethod[]> {
    this.chain ??= tpsChain({
      loader: this.options.loader,
      mcVersion: this.options.mcVersion,
      sparkInstalled: await detectSpark(this.options.serverDir),
    });
    return this.chain;
  }

  private async tryMethod(method: TpsMethod): Promise<TpsReading | undefined> {
    try {
      const response = await this.options.exec(method.command, this.options.timeoutMs ?? 5000);
      const reading = parseTpsResponse(method.source, response);
      if (!reading || (reading.tps === undefined && reading.mspt === undefined)) return undefined;
      return reading;
    } catch {
      return undefined;
    }
  }
}
