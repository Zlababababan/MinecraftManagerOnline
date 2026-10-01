import { describe, expect, it } from 'vitest';

import { PoliteFetchError, PoliteFetcher, USER_AGENT, parseRetryAfter } from './polite-fetch.js';

interface Call {
  url: string;
  headers: Record<string, string>;
}

/** Faux réseau : chaque réponse est décidée par `answer`, les appels sont comptés. */
function harness(
  answer: (url: string, n: number) => Promise<Response> | Response,
  options: { maxRetries?: number } = {},
) {
  let clock = 1_000_000;
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const fetchImpl = ((input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    return Promise.resolve(answer(url, calls.length));
  }) as typeof fetch;
  const fetcher = new PoliteFetcher({
    fetchImpl,
    ...options,
    now: () => clock,
    sleep: (ms) => {
      sleeps.push(ms);
      clock += ms;
      return Promise.resolve();
    },
  });
  return {
    fetcher,
    calls,
    sleeps,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const ok = (body = '{}') => new Response(body, { status: 200 });

describe('PoliteFetcher — appels aux services tiers', () => {
  it('se présente : User-Agent qui nomme le produit, sa version et le dépôt', async () => {
    const h = harness(() => ok());
    await h.fetcher.get('https://api.example.test/a', { accept: 'application/json' });
    expect(h.calls[0]?.headers['user-agent']).toBe(USER_AGENT);
    expect(USER_AGENT).toMatch(
      /^MinecraftManagerOnline\/\d+\.\d+\.\d+ \(\+https:\/\/github\.com\//,
    );
    expect(h.calls[0]?.headers.accept).toBe('application/json');
  });

  it('partage une requête identique en vol, et la refait une fois terminée', async () => {
    let release: (() => void) | undefined;
    const h = harness(
      () =>
        new Promise<Response>((resolve) => {
          release = () => {
            resolve(ok('x'));
          };
        }),
    );
    const a = h.fetcher.get('https://api.example.test/list');
    const b = h.fetcher.get('https://api.example.test/list');
    await Promise.resolve();
    release?.();
    expect((await a).text).toBe('x');
    expect((await b).text).toBe('x');
    expect(h.calls).toHaveLength(1);
    const c = h.fetcher.get('https://api.example.test/list');
    await Promise.resolve();
    release?.();
    await c;
    expect(h.calls).toHaveLength(2);
  });

  it('borne la concurrence PAR HÔTE : vingt fiches partent trois par trois', async () => {
    let active = 0;
    let peak = 0;
    const pending: (() => void)[] = [];
    const h = harness(
      () =>
        new Promise<Response>((resolve) => {
          active += 1;
          peak = Math.max(peak, active);
          pending.push(() => {
            active -= 1;
            resolve(ok());
          });
        }),
    );
    const all = Array.from({ length: 20 }, (_, i) =>
      h.fetcher.get(`https://api.example.test/pack/${String(i)}`),
    );
    // Un autre hôte n'attend pas derrière le premier.
    const other = h.fetcher.get('https://other.example.test/x');
    const tick = () => new Promise((r) => setTimeout(r, 0));
    await tick();
    expect(h.calls.filter((c) => c.url.includes('api.example')).length).toBe(3);
    expect(h.calls.some((c) => c.url.includes('other.example'))).toBe(true);
    for (let i = 0; i < 500 && (h.calls.length < 21 || pending.length > 0); i += 1) {
      pending.shift()?.();
      await tick();
    }
    await Promise.all([...all, other]);
    expect(h.calls).toHaveLength(21);
    expect(peak).toBeLessThanOrEqual(4); // 3 sur le premier hôte + 1 sur l'autre
  });

  it('par défaut, aucune relance : un 429 est rendu tel quel et l’hôte est mis au repos', async () => {
    const h = harness(() => new Response('', { status: 429, headers: { 'retry-after': '2' } }));
    const res = await h.fetcher.get('https://api.example.test/a');
    expect(res.status).toBe(429);
    expect(h.sleeps).toEqual([]);
    expect(h.calls).toHaveLength(1);
    expect(h.fetcher.restingFor('https://api.example.test/b')).toBeGreaterThan(0);
  });

  it('avec maxRetries, attend un Retry-After court puis réessaie', async () => {
    const h = harness(
      (_url, n) =>
        n === 1 ? new Response('', { status: 429, headers: { 'retry-after': '2' } }) : ok('bon'),
      { maxRetries: 2 },
    );
    const res = await h.fetcher.get('https://api.example.test/a');
    expect(res.text).toBe('bon');
    expect(h.sleeps).toEqual([2000]);
    expect(h.calls).toHaveLength(2);
  });

  it('un Retry-After long met l’hôte au repos : aucune requête avant son terme', async () => {
    const h = harness((_url, n) =>
      n === 1 ? new Response('', { status: 429, headers: { 'retry-after': '120' } }) : ok(),
    );
    expect((await h.fetcher.get('https://api.example.test/a')).status).toBe(429);
    expect(h.sleeps).toEqual([]);
    const refused = await h.fetcher.get('https://api.example.test/b').catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(PoliteFetchError);
    expect((refused as PoliteFetchError).kind).toBe('cooling_down');
    expect((refused as PoliteFetchError).retryInMs).toBe(120_000);
    expect(h.calls).toHaveLength(1);
    h.advance(120_000);
    expect((await h.fetcher.get('https://api.example.test/b')).status).toBe(200);
  });

  it('429 répétés : recul croissant, puis repos', async () => {
    const h = harness(() => new Response('', { status: 429 }), { maxRetries: 2 });
    const res = await h.fetcher.get('https://api.example.test/a');
    expect(res.status).toBe(429);
    expect(h.sleeps).toEqual([1000, 2000]);
    expect(h.calls).toHaveLength(3);
    expect(h.fetcher.restingFor('https://api.example.test/z')).toBeGreaterThan(0);
  });

  it('cache négatif : un service en panne n’est pas relancé à chaque clic, et le repos double', async () => {
    let down = true;
    const h = harness(() => (down ? Promise.reject(new Error('ECONNREFUSED')) : ok()));
    const first = await h.fetcher.get('https://api.example.test/a').catch((e: unknown) => e);
    expect((first as PoliteFetchError).kind).toBe('network');
    // Dix clics pendant la panne : aucun ne sort.
    for (let i = 0; i < 10; i += 1) {
      const e = await h.fetcher.get('https://api.example.test/a').catch((err: unknown) => err);
      expect((e as PoliteFetchError).kind).toBe('cooling_down');
    }
    expect(h.calls).toHaveLength(1);
    h.advance(60_000);
    await h.fetcher.get('https://api.example.test/a').catch(() => undefined);
    expect(h.calls).toHaveLength(2);
    // Seconde panne consécutive : 2 minutes.
    expect(h.fetcher.restingFor('https://api.example.test/a')).toBe(120_000);
    h.advance(120_000);
    down = false;
    expect((await h.fetcher.get('https://api.example.test/a')).ok).toBe(true);
    // Guéri : la prochaine panne repart d'une minute.
    down = true;
    await h.fetcher.get('https://api.example.test/a').catch(() => undefined);
    expect(h.fetcher.restingFor('https://api.example.test/a')).toBe(60_000);
  });

  it('une réponse 5xx est rendue, et met l’hôte au repos ; un 404 non', async () => {
    const h = harness((url) =>
      url.endsWith('/missing')
        ? new Response('', { status: 404 })
        : new Response('', { status: 502 }),
    );
    expect((await h.fetcher.get('https://api.example.test/missing')).status).toBe(404);
    expect(h.fetcher.restingFor('https://api.example.test/')).toBe(0);
    expect((await h.fetcher.get('https://api.example.test/a')).status).toBe(502);
    expect(h.fetcher.restingFor('https://api.example.test/')).toBe(60_000);
  });

  it('lit Retry-After en secondes ou en date HTTP', () => {
    const now = Date.parse('2026-09-28T12:00:00Z');
    expect(parseRetryAfter('5', now)).toBe(5000);
    expect(parseRetryAfter('Mon, 28 Sep 2026 12:00:30 GMT', now)).toBe(30_000);
    expect(parseRetryAfter(null, now)).toBeUndefined();
    expect(parseRetryAfter('bientôt', now)).toBeUndefined();
  });
});
