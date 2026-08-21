/** Backoff de reconnexion (doc 05 §5, §13) : 1 s → 60 s, doublement, jitter ±20 %. */

export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  jitter?: number;
  random?: () => number;
}

export function backoffDelay(attempt: number, options: BackoffOptions = {}): number {
  const base = options.baseMs ?? 1000;
  const max = options.maxMs ?? 60_000;
  const jitter = options.jitter ?? 0.2;
  const random = options.random ?? Math.random;
  const exp = Math.min(max, base * 2 ** Math.max(0, Math.min(attempt, 30)));
  const factor = 1 + (random() * 2 - 1) * jitter;
  return Math.round(Math.min(max * (1 + jitter), exp * factor));
}

export class Backoff {
  private attempt = 0;
  constructor(private readonly options: BackoffOptions = {}) {}

  next(): number {
    return backoffDelay(this.attempt++, this.options);
  }

  reset(): void {
    this.attempt = 0;
  }

  get attempts(): number {
    return this.attempt;
  }
}
