/**
 * Appels aux services tenus par d'autres (catalogues Mojang, Fabric, Forge, NeoForge, FTB, spark) :
 * **un seul point de passage, poli dès la première requête** (docs/services-tiers.md).
 *
 * Pourquoi : un outil qui martèle une API se fait bloquer, et le blocage frappe tous ses
 * utilisateurs à la fois ; ces services sont souvent gratuits et tenus par de petites équipes.
 *
 * Ce que fait ce module, pour chaque hôte :
 * - `User-Agent` qui nomme le produit, sa version et le dépôt (un client identifiable) ;
 * - **concurrence bornée** (`maxPerHost`, 3 par défaut) : une recherche qui veut vingt fiches les
 *   obtient trois par trois, jamais en rafale ;
 * - **requêtes identiques en vol partagées** : dix onglets qui ouvrent la même liste = un appel ;
 * - **`429`/`503` respectés, sans relance automatique** (demande de Yassin, 01/10 : « évite les
 *   relances ») : l'hôte est mis au repos pour la durée demandée (`Retry-After`), l'appelant reçoit
 *   la réponse et l'interface le dit ; `maxRetries` (0 par défaut) permettrait d'attendre un
 *   `Retry-After` court ; recul croissant à chaque échec consécutif ;
 * - **cache négatif** : un hôte en panne (réseau, 5xx) n'est plus sollicité pendant `negativeTtlMs`
 *   (1 min, doublé à chaque échec suivant, plafonné à 15 min) — un clic ne relance pas un service
 *   tombé.
 *
 * Le cache POSITIF (listes 1 h, détails publiés pour toujours) reste chez chaque appelant : lui seul
 * sait ce qui vieillit.
 */
import { PANEL_VERSION } from '../version.js';

export const PROJECT_URL = 'https://github.com/Zlababababan/MinecraftManagerOnline';
export const USER_AGENT = `MinecraftManagerOnline/${PANEL_VERSION} (+${PROJECT_URL})`;

/** En-têtes à poser sur un appel sortant qui ne passe pas par `PoliteFetcher` (flux, POST). */
export function politeHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { 'user-agent': USER_AGENT, ...extra };
}

/**
 * `fetch` qui se présente : pose le `User-Agent` du panel quand l'appelant n'en a pas mis. Pour les
 * services qui ont leur propre client (ACME, DNS dynamique, manifest Mojang du résolveur Java) et ne
 * passent donc pas par `PoliteFetcher` — un appel anonyme est le premier qu'un service coupe.
 */
export function identifiedFetch(fetchImpl: typeof fetch): typeof fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    if (!headers.has('user-agent')) headers.set('user-agent', USER_AGENT);
    return fetchImpl(input, { ...init, headers });
  };
}

export interface PoliteResponse {
  status: number;
  ok: boolean;
  text: string;
}

export type PoliteFailure = 'network' | 'cooling_down';

/** Aucun appel n'a abouti : réseau en échec, ou hôte au repos après une panne ou un 429. */
export class PoliteFetchError extends Error {
  constructor(
    readonly kind: PoliteFailure,
    readonly host: string,
    /** Temps avant que l'hôte soit de nouveau sollicité (repos seulement). */
    readonly retryInMs?: number,
  ) {
    super(kind === 'network' ? `${host} is unreachable` : `${host} is cooling down after failures`);
    this.name = 'PoliteFetchError';
  }
}

/**
 * Raison d'erreur à montrer pour une réponse en échec : « le service demande de ralentir » (429,
 * 503) n'appelle pas le même message qu'une erreur quelconque.
 */
export function busyOrHttp(status: number): 'CATALOG_BUSY' | 'CATALOG_HTTP' {
  return status === 429 || status === 503 ? 'CATALOG_BUSY' : 'CATALOG_HTTP';
}

export interface PoliteFetcherOptions {
  fetchImpl?: typeof fetch | undefined;
  now?: () => number;
  /** Attente annulable, injectée par les tests. */
  sleep?: (ms: number) => Promise<void>;
  logger?: { warn: (obj: object, msg: string) => void };
  maxPerHost?: number;
  /** Repos d'un hôte après une panne (doublé à chaque panne suivante). */
  negativeTtlMs?: number;
  /** Plafond du repos, pannes répétées comprises. */
  maxCooldownMs?: number;
  /** Au-delà, un `Retry-After` n'est pas attendu : l'hôte est mis au repos d'autant. */
  maxRetryWaitMs?: number;
  /** Nouvelles tentatives après un `429`/`503`. */
  maxRetries?: number;
  timeoutMs?: number;
}

interface HostState {
  active: number;
  queue: (() => void)[];
  /** Aucune requête avant cet instant. */
  restUntil: number;
  /** Échecs consécutifs : chacun double le repos suivant. */
  failures: number;
}

const DEFAULTS = {
  maxPerHost: 3,
  negativeTtlMs: 60_000,
  maxCooldownMs: 15 * 60_000,
  maxRetryWaitMs: 10_000,
  maxRetries: 0,
  timeoutMs: 15_000,
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });

/** `Retry-After` en secondes ou en date HTTP ; `undefined` si absent ou illisible. */
export function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

export class PoliteFetcher {
  private readonly hosts = new Map<string, HostState>();
  private readonly inflight = new Map<string, Promise<PoliteResponse>>();
  private readonly o: typeof DEFAULTS;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: PoliteFetcherOptions = {}) {
    this.o = {
      maxPerHost: options.maxPerHost ?? DEFAULTS.maxPerHost,
      negativeTtlMs: options.negativeTtlMs ?? DEFAULTS.negativeTtlMs,
      maxCooldownMs: options.maxCooldownMs ?? DEFAULTS.maxCooldownMs,
      maxRetryWaitMs: options.maxRetryWaitMs ?? DEFAULTS.maxRetryWaitMs,
      maxRetries: options.maxRetries ?? DEFAULTS.maxRetries,
      timeoutMs: options.timeoutMs ?? DEFAULTS.timeoutMs,
    };
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /**
   * GET d'un document (JSON, XML, texte) lu en entier. Deux appels identiques en vol partagent la
   * même requête. Lève `PoliteFetchError` si rien n'a pu être demandé ; rend la réponse sinon,
   * statut d'erreur compris (à l'appelant de dire ce qu'un 404 signifie).
   */
  get(url: string, init: { accept?: string; timeoutMs?: number } = {}): Promise<PoliteResponse> {
    const shared = this.inflight.get(url);
    if (shared) return shared;
    const run = this.run(url, init).finally(() => {
      this.inflight.delete(url);
    });
    this.inflight.set(url, run);
    return run;
  }

  /** Temps de repos restant d'un hôte (0 = sollicitable). Pour les tests et le diagnostic. */
  restingFor(url: string): number {
    const state = this.hosts.get(new URL(url).host);
    return state === undefined ? 0 : Math.max(0, state.restUntil - this.now());
  }

  private state(host: string): HostState {
    let state = this.hosts.get(host);
    if (!state) {
      state = { active: 0, queue: [], restUntil: 0, failures: 0 };
      this.hosts.set(host, state);
    }
    return state;
  }

  private async acquire(state: HostState): Promise<void> {
    if (state.active < this.o.maxPerHost) {
      state.active += 1;
      return;
    }
    // Le créneau est transmis directement par `release` : `active` ne redescend pas entre-temps.
    await new Promise<void>((resolve) => state.queue.push(resolve));
  }

  private release(state: HostState): void {
    const next = state.queue.shift();
    if (next) next();
    else state.active -= 1;
  }

  private assertAwake(host: string, state: HostState): void {
    const left = state.restUntil - this.now();
    if (left > 0) throw new PoliteFetchError('cooling_down', host, left);
  }

  /** Une panne de plus : repos doublé à chaque fois, jamais plus court que ce que l'hôte a demandé. */
  private rest(host: string, state: HostState, askedMs = 0): void {
    state.failures += 1;
    const backoff = Math.min(
      this.o.negativeTtlMs * 2 ** (state.failures - 1),
      this.o.maxCooldownMs,
    );
    const ms = Math.min(Math.max(backoff, askedMs), this.o.maxCooldownMs);
    state.restUntil = Math.max(state.restUntil, this.now() + ms);
    this.options.logger?.warn(
      { host, restMs: ms, failures: state.failures },
      'third-party service resting',
    );
  }

  private async run(
    url: string,
    init: { accept?: string; timeoutMs?: number },
  ): Promise<PoliteResponse> {
    const host = new URL(url).host;
    const state = this.state(host);
    this.assertAwake(host, state);
    await this.acquire(state);
    try {
      // Une panne a pu survenir pendant l'attente du créneau.
      this.assertAwake(host, state);
      const doFetch = this.options.fetchImpl ?? globalThis.fetch;
      for (let attempt = 0; ; attempt += 1) {
        let res: Response;
        let text: string;
        try {
          res = await doFetch(url, {
            headers: politeHeaders(init.accept === undefined ? {} : { accept: init.accept }),
            signal: AbortSignal.timeout(init.timeoutMs ?? this.o.timeoutMs),
          });
          text = await res.text();
        } catch (error) {
          this.options.logger?.warn({ url, error: String(error) }, 'third-party fetch failed');
          this.rest(host, state);
          throw new PoliteFetchError('network', host);
        }
        const response: PoliteResponse = { status: res.status, ok: res.ok, text };
        if (res.status === 429 || res.status === 503) {
          const asked = parseRetryAfter(res.headers.get('retry-after'), this.now());
          const wait = asked ?? 1000 * 2 ** attempt;
          if (attempt < this.o.maxRetries && wait <= this.o.maxRetryWaitMs) {
            await this.sleep(wait);
            continue;
          }
          this.rest(host, state, asked ?? 0);
          return response;
        }
        if (res.status >= 500) {
          this.rest(host, state);
          return response;
        }
        state.failures = 0;
        return response;
      }
    } finally {
      this.release(state);
    }
  }
}
