/** Limiteur mémoire à fenêtre glissante (login, appairage). Clé libre (IP, IP+utilisateur…). */
export interface RateLimiterOptions {
  max: number;
  windowMs: number;
  now?: () => number;
}

export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly now: () => number;

  constructor(private readonly options: RateLimiterOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  /** `true` si l'action est autorisée (et la comptabilise). */
  hit(key: string): boolean {
    const t = this.now();
    const since = t - this.options.windowMs;
    const list = (this.hits.get(key) ?? []).filter((x) => x > since);
    if (list.length >= this.options.max) {
      this.hits.set(key, list);
      return false;
    }
    list.push(t);
    this.hits.set(key, list);
    if (this.hits.size > 10_000) this.prune(since);
    return true;
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  private prune(since: number): void {
    for (const [key, list] of this.hits) {
      const kept = list.filter((x) => x > since);
      if (kept.length === 0) this.hits.delete(key);
      else this.hits.set(key, kept);
    }
  }
}
