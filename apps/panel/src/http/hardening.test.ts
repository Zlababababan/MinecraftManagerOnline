/**
 * Phase 12 — dette sécurité doc 03 §6 : `/api/setup` verrouillé (un seul POST à la fois) et limité
 * par adresse ; `/ws/probe` borné (connexions simultanées, taille de frame, volume renvoyé).
 */
import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestPanel, type TestPanel } from '../test/helpers.js';

/** Ouvre une sonde ; les frames binaires reçues sont accumulées dès la connexion (l'accueil JSON est émis dans le même tick que `open`). */
function openProbe(url: string): Promise<WebSocket & { binary: Buffer[] }> {
  return new Promise((resolve, reject) => {
    const ws = Object.assign(new WebSocket(url), { binary: [] as Buffer[] });
    ws.on('message', (d: Buffer, isBinary: boolean) => {
      if (isBinary) ws.binary.push(Buffer.from(d));
    });
    ws.once('open', () => {
      resolve(ws);
    });
    ws.once('error', reject);
  });
}

function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = (): void => {
      if (cond()) resolve();
      else if (Date.now() - started > ms) reject(new Error('timeout'));
      else setTimeout(tick, 10);
    };
    tick();
  });
}

function closed(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    ws.once('close', (code: number) => {
      resolve(code);
    });
  });
}

describe('phase 12 — durcissement', () => {
  let panel: TestPanel;

  beforeEach(async () => {
    panel = await createTestPanel();
  });
  afterEach(async () => {
    await panel.close();
  });

  it('/api/setup : deux POST concurrents ne créent qu’un admin ; 5 tentatives/min par adresse', async () => {
    const payload = { username: 'admin', password: 'correct horse battery' };
    const burst = await Promise.all(
      Array.from({ length: 3 }, () =>
        panel.app.inject({ method: 'POST', url: '/api/setup', payload }),
      ),
    );
    const codes = burst.map((r) => r.statusCode).sort();
    expect(codes.filter((c) => c === 201)).toHaveLength(1);
    expect(codes.filter((c) => c === 409 || c === 503)).toHaveLength(2);
    expect(panel.ctx.users.count()).toBe(1);

    // Limite par adresse : sur un panel vierge, la 6e tentative en 1 min est refusée (429).
    const fresh = await createTestPanel();
    try {
      const results: number[] = [];
      for (let i = 0; i < 6; i++) {
        const res = await fresh.app.inject({
          method: 'POST',
          url: '/api/setup',
          payload: { username: 'a', password: 'short' },
          remoteAddress: '203.0.113.9',
        });
        results.push(res.statusCode);
      }
      expect(results).toEqual([400, 400, 400, 400, 400, 429]);
      // Une autre adresse n'est pas pénalisée.
      const other = await fresh.app.inject({
        method: 'POST',
        url: '/api/setup',
        payload: { username: 'a', password: 'short' },
        remoteAddress: '203.0.113.10',
      });
      expect(other.statusCode).toBe(400);
    } finally {
      await fresh.close();
    }
  });

  it('/ws/probe : au plus 8 sondes simultanées, frame > 256 KiB refusée (1009)', async () => {
    await panel.listen();
    const url = `${panel.wsUrl}/ws/probe`;
    const sockets: (WebSocket & { binary: Buffer[] })[] = [];
    for (let i = 0; i < 8; i++) sockets.push(await openProbe(url));
    const ninth = await openProbe(url);
    expect(await closed(ninth)).toBe(1013);
    // Libérer une place : la suivante passe et répond bien en écho.
    const first = sockets.shift();
    first?.close();
    if (first) await closed(first);
    const next = await openProbe(url);
    const payload = Buffer.alloc(64 * 1024, 3);
    next.send(payload, { binary: true });
    await waitFor(() => next.binary.length === 1);
    expect(next.binary[0]?.equals(payload)).toBe(true);
    const tooBig = closed(next);
    next.send(Buffer.alloc(256 * 1024 + 1), { binary: true });
    expect(await tooBig).toBe(1009);
    for (const s of sockets) s.close();
  });
});
