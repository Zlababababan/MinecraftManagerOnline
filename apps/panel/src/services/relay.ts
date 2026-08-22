/**
 * Jetons de relais (phase 9) : URLs `/api/relay/<token>` servies **sans session** aux agents pour
 * télécharger depuis le panel — bundle d'agent (`agent.update`), JRE mis en cache (mode relais de
 * `java.install`), archive de migration relayée depuis l'agent source (repli du transfert direct).
 * Jeton 32 hex, TTL court, réutilisable jusqu'à expiration (reprise `Range`), révocable.
 */
import { randomBytes } from 'node:crypto';

export type RelayPayload =
  | { kind: 'bundle'; version: string; file: string; size: number; fileName: string }
  | { kind: 'java'; file: string; size: number; fileName: string }
  | {
      kind: 'migration';
      migrationId: string;
      machineId: string;
      serverId: string;
      backupId: string;
      size: number;
      fileName: string;
    };

interface Entry {
  payload: RelayPayload;
  expiresAt: number;
}

export class RelayTokens {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly now: () => number) {}

  issue(payload: RelayPayload, ttlMs: number): string {
    this.purge();
    const token = randomBytes(16).toString('hex');
    this.entries.set(token, { payload, expiresAt: this.now() + ttlMs });
    return token;
  }

  get(token: string): RelayPayload | undefined {
    this.purge();
    const entry = this.entries.get(token);
    return entry === undefined || entry.expiresAt <= this.now() ? undefined : entry.payload;
  }

  revoke(token: string): void {
    this.entries.delete(token);
  }

  /** Révoque tous les jetons d'une migration (fin ou échec). */
  revokeMigration(migrationId: string): void {
    for (const [token, entry] of this.entries) {
      if (entry.payload.kind === 'migration' && entry.payload.migrationId === migrationId) {
        this.entries.delete(token);
      }
    }
  }

  get size(): number {
    this.purge();
    return this.entries.size;
  }

  private purge(): void {
    const t = this.now();
    for (const [token, entry] of this.entries) if (entry.expiresAt <= t) this.entries.delete(token);
  }
}

export function relayUrl(token: string): string {
  return `/api/relay/${token}`;
}
