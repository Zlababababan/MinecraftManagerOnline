/**
 * Lot 4 — transport HTTP des webhooks : `node:http(s)` plutôt que `fetch`, parce que c'est le seul
 * moyen d'ÉPINGLER l'adresse validée par la garde SSRF (option `lookup` de `net.connect`) tout en
 * gardant le nom d'hôte pour le SNI et l'en-tête `Host`. Aucune redirection suivie (un 3xx vers
 * 127.0.0.1 serait la porte dérobée évidente : il revient comme un échec définitif), réponse lue au
 * plus 64 Kio, délai borné par `AbortSignal.timeout`.
 *
 * `http:` n'est accepté ici que pour les tests (serveur local) : la garde refuse tout sauf https.
 */
import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';

import type { WebhookTarget } from './ssrf.js';

export interface WebhookRequest {
  target: WebhookTarget;
  headers: Record<string, string>;
  body: Buffer;
  timeoutMs: number;
}

export interface WebhookResponse {
  status: number;
  /** Corps tronqué à `MAX_RESPONSE_BYTES` (un 4xx Discord dit en une ligne ce qui cloche). */
  body: string;
  /** `Retry-After` (secondes ou date HTTP) converti en millisecondes, si présent. */
  retryAfterMs: number | undefined;
}

export type WebhookTransport = (request: WebhookRequest) => Promise<WebhookResponse>;

export const MAX_RESPONSE_BYTES = 64 * 1024;

/** `lookup` qui rend toujours l'adresse épinglée, quel que soit le nom demandé. */
function pinnedLookup(target: WebhookTarget): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all === true) callback(null, [{ address: target.address, family: target.family }]);
    else callback(null, target.address, target.family);
  };
}

export function parseRetryAfter(
  value: string | string[] | undefined,
  now: number,
): number | undefined {
  const text = (Array.isArray(value) ? value[0] : value)?.trim();
  if (text === undefined || text === '') return undefined;
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const at = Date.parse(text);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

export const httpTransport: WebhookTransport = (request) =>
  new Promise<WebhookResponse>((resolve, reject) => {
    const { target } = request;
    const client = target.url.protocol === 'https:' ? https : http;
    const req = client.request(
      {
        protocol: target.url.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${target.url.pathname}${target.url.search}`,
        method: 'POST',
        headers: { ...request.headers, 'content-length': String(request.body.length) },
        lookup: pinnedLookup(target),
        signal: AbortSignal.timeout(request.timeoutMs),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let settled = false;
        const done = (): void => {
          if (settled) return;
          settled = true;
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
            retryAfterMs: parseRetryAfter(res.headers['retry-after'], Date.now()),
          });
        };
        res.on('data', (chunk: Buffer) => {
          if (size >= MAX_RESPONSE_BYTES) return;
          const room = MAX_RESPONSE_BYTES - size;
          chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
          size += chunk.length;
          // Au-delà du plafond : on n'attend pas la fin d'un corps sans intérêt.
          if (size >= MAX_RESPONSE_BYTES) res.destroy();
        });
        res.on('end', done);
        res.on('close', done);
      },
    );
    req.on('error', reject);
    req.end(request.body);
  });
