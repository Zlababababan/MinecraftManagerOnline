/**
 * Lot 4 — transport des webhooks contre un vrai serveur HTTP local : l'adresse épinglée est
 * contactée alors que le nom ne se résout pas, `Host` garde le nom, aucune redirection n'est
 * suivie, la réponse est bornée, le délai coupe.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { WebhookTarget } from './ssrf.js';
import { MAX_RESPONSE_BYTES, httpTransport, parseRetryAfter } from './transport.js';

interface Seen {
  host: string | undefined;
  path: string;
  body: string;
  headers: http.IncomingHttpHeaders;
}

let server: http.Server;
let port = 0;
const seen: Seen[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.on('error', () => undefined);
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const path = req.url ?? '';
      seen.push({
        host: req.headers.host,
        path,
        body: Buffer.concat(chunks).toString(),
        headers: req.headers,
      });
      if (path === '/redirect') {
        res.writeHead(302, { location: `http://127.0.0.1:${String(port)}/evil` });
        res.end();
        return;
      }
      if (path === '/big') {
        res.writeHead(200);
        res.end('x'.repeat(MAX_RESPONSE_BYTES * 3));
        return;
      }
      if (path === '/slow') {
        const timer = setTimeout(() => {
          if (!res.destroyed) {
            res.writeHead(200);
            res.end('late');
          }
        }, 2_000);
        timer.unref();
        return;
      }
      if (path === '/429') {
        res.writeHead(429, { 'retry-after': '3' });
        res.end('{"retry_after":2.5}');
        return;
      }
      res.writeHead(204);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
});

/** Nom fictif + adresse épinglée 127.0.0.1 : seule l'adresse doit être contactée, le nom ne se résout pas. */
function target(path: string): WebhookTarget {
  return {
    url: new URL(`http://webhook.example.com:${String(port)}${path}`),
    hostname: 'webhook.example.com',
    port,
    address: '127.0.0.1',
    family: 4,
  };
}

const post = (path: string, timeoutMs = 5_000) =>
  httpTransport({
    target: target(path),
    headers: { 'content-type': 'application/json', 'x-mmo-event': 'test' },
    body: Buffer.from('{"a":1}'),
    timeoutMs,
  });

describe('transport des webhooks', () => {
  it('contacte l’adresse épinglée, garde le nom dans Host, poste le corps tel quel', async () => {
    const res = await post('/hook?x=1');
    expect(res.status).toBe(204);
    const last = seen[seen.length - 1];
    expect(last).toMatchObject({
      host: `webhook.example.com:${String(port)}`,
      path: '/hook?x=1',
      body: '{"a":1}',
    });
    expect(last?.headers['x-mmo-event']).toBe('test');
    expect(last?.headers['content-length']).toBe('7');
  });

  it('ne suit aucune redirection : le 302 revient tel quel, la cible du Location n’est jamais appelée', async () => {
    const res = await post('/redirect');
    expect(res.status).toBe(302);
    expect(seen.filter((s) => s.path === '/evil')).toHaveLength(0);
  });

  it('borne la lecture de la réponse et remonte Retry-After', async () => {
    const big = await post('/big');
    expect(big.status).toBe(200);
    expect(big.body.length).toBe(MAX_RESPONSE_BYTES);
    const limited = await post('/429');
    expect(limited).toMatchObject({ status: 429, retryAfterMs: 3_000 });
    expect(limited.body).toBe('{"retry_after":2.5}');
  });

  it('abandonne après le délai', async () => {
    await expect(post('/slow', 200)).rejects.toThrow();
  });

  it('Retry-After : secondes ou date HTTP, sinon rien', () => {
    expect(parseRetryAfter('3', 0)).toBe(3_000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6_000);
    expect(parseRetryAfter(['7'], 0)).toBe(7_000);
    expect(parseRetryAfter('garbage', 0)).toBeUndefined();
    expect(parseRetryAfter(undefined, 0)).toBeUndefined();
  });
});
