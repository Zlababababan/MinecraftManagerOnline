/**
 * Outils de test (non bundlés) : ports libres, dossiers temporaires, fake Java server, faux panel
 * WebSocket (`ws`) avec un `RpcPeer` rôle `panel`.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';

import { createRpcPeer, type RpcPeer, type RpcTransport } from '@mmo/protocol';

import type { LaunchCommand } from '../minecraft/launch.js';

export const FAKE_SERVER = path.resolve(import.meta.dirname, '../../test/fake-java-server.mjs');

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const address = srv.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      srv.close(() => {
        resolve(port);
      });
    });
    srv.on('error', reject);
  });
}

export async function tmpDir(
  prefix = 'mmo-agent-',
): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  return {
    dir,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
    },
  };
}

/** Commande de lancement du fake server (remplace `java …`). */
export function fakeServerCommand(cwd: string, args: string[] = []): LaunchCommand {
  return {
    file: process.execPath,
    args: [FAKE_SERVER, ...args],
    cwd,
    cmdlineKey: 'fake-java-server.mjs',
    files: [],
  };
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
  intervalMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(intervalMs);
  }
  throw new Error(`waitFor: condition not met within ${String(timeoutMs)} ms`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Faux panel -----------------------------------------------------------------------------------

export type PanelPeer = RpcPeer<'panel'>;

export interface FakePanel {
  url: string;
  /** Pairs connectés (un par session agent), le dernier en fin de liste. */
  peers: PanelPeer[];
  /** Résout au prochain pair créé. */
  nextPeer(): Promise<PanelPeer>;
  /** Ferme toutes les connexions agent sans arrêter le serveur (test de reconnexion). */
  dropAll(): void;
  /** Panne simulée : les nouvelles connexions sont coupées immédiatement jusqu'à `resume()`. */
  pause(): void;
  resume(): void;
  close(): Promise<void>;
}

function wsTransport(ws: WebSocket): RpcTransport {
  return {
    send: (data) => {
      ws.send(data);
    },
    onMessage: (handler) => {
      ws.on('message', (data) => {
        handler(typeof data === 'string' ? data : Buffer.from(data as Buffer).toString('utf8'));
      });
    },
    onClose: (handler) => {
      ws.on('close', (code, reason) => {
        handler(`${String(code)} ${reason.toString()}`);
      });
    },
  };
}

export async function createFakePanel(
  configure: (peer: PanelPeer, ws: WebSocket) => void,
): Promise<FakePanel> {
  const port = await freePort();
  const wss = new WebSocketServer({ port, path: '/ws/agent' });
  await new Promise<void>((resolve) => {
    wss.once('listening', resolve);
  });
  const peers: PanelPeer[] = [];
  const sockets = new Set<WebSocket>();
  const waiters: ((peer: PanelPeer) => void)[] = [];
  let paused = false;
  wss.on('connection', (ws) => {
    if (paused) {
      ws.terminate();
      return;
    }
    sockets.add(ws);
    ws.on('close', () => sockets.delete(ws));
    const peer = createRpcPeer({
      role: 'panel',
      transport: wsTransport(ws),
      logger: {
        warn: (message, context) => {
          process.stderr.write(`[fake-panel] ${message} ${JSON.stringify(context ?? {})}
`);
        },
      },
    });
    configure(peer, ws);
    peers.push(peer);
    for (const w of waiters.splice(0)) w(peer);
  });
  return {
    url: `ws://127.0.0.1:${String(port)}/ws/agent`,
    peers,
    nextPeer: () =>
      new Promise((resolve) => {
        waiters.push(resolve);
      }),
    dropAll: () => {
      for (const ws of sockets) ws.close(4000, 'dropped');
    },
    pause: () => {
      paused = true;
      for (const ws of sockets) ws.close(4000, 'paused');
    },
    resume: () => {
      paused = false;
    },
    close: () =>
      new Promise((resolve) => {
        for (const ws of sockets) ws.terminate();
        wss.close(() => {
          resolve();
        });
      }),
  };
}
