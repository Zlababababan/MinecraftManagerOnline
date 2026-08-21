/**
 * Cache d'idempotence des réponses (doc 05 §1, §13) : rejouer une requête avec le même `id` est
 * toujours sûr — la réponse mémorisée est renvoyée sans ré-exécution. Défauts : 10 min / 1 000 entrées.
 */

export interface IdempotencyCacheOptions {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

interface Entry<V> {
  value: V;
  expiresAt: number;
}

export class IdempotencyCache<V> {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, Entry<V>>();

  constructor(options: IdempotencyCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? 10 * 60_000;
    this.maxEntries = options.maxEntries ?? 1000;
    this.now = options.now ?? (() => Date.now());
  }

  get(id: string): V | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(id);
      return undefined;
    }
    return entry.value;
  }

  set(id: string, value: V): void {
    this.entries.delete(id);
    this.entries.set(id, { value, expiresAt: this.now() + this.ttlMs });
    this.evict();
  }

  get size(): number {
    return this.entries.size;
  }

  private evict(): void {
    const now = this.now();
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt > now && this.entries.size <= this.maxEntries) break;
      this.entries.delete(id);
    }
  }
}
