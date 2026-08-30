/**
 * Limiteur mémoire à fenêtre glissante (login, appairage). Clé libre (IP, IP+utilisateur…).
 *
 * ⚠ Toute clé dérivée d'une adresse doit passer par `clientKey()` : une adresse IPv6 complète
 * donne 2^64 clés à un même abonné, donc aucune limite effective — et la carte grossit d'une
 * entrée par tentative jusqu'à déclencher la purge en O(n) à chaque appel.
 */

/** Forme `::ffff:1.2.3.4` que Node rend sur une socket double pile : c'est de l'IPv4. */
const IPV4_MAPPED = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i;

/**
 * Réduit une adresse à ce qui identifie réellement un abonné : IPv4 telle quelle, IPv6 ramenée à
 * son préfixe /64 (les quatre premiers groupes).
 */
export function clientKey(ip: string | undefined): string {
  if (ip === undefined || ip === '') return 'unknown';
  const mapped = IPV4_MAPPED.exec(ip);
  if (mapped?.[1] !== undefined) return mapped[1];
  if (!ip.includes(':')) return ip;
  const address = ip.split('%')[0] ?? ip; // identifiant de zone (`fe80::1%eth0`) ignoré
  return `${address.split(':').slice(0, 4).join(':')}::/64`;
}

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
