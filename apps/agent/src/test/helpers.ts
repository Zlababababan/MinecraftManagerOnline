/**
 * Outils de test (non bundlés) : ports libres, dossiers temporaires, fake Java server, faux panel
 * WebSocket (`ws`) avec un `RpcPeer` rôle `panel`.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { deflateRawSync, gzipSync } from 'node:zlib';
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

/** Sur les runners CI partagés (2 cœurs), toutes les cadences dérapent : délais ×3, en un point. */
const WAIT_FACTOR = process.env.CI === undefined ? 1 : 3;

/** Budget explicite d'un test : suit le même facteur CI que les attentes. */
export function testBudget(ms: number): number {
  return ms * WAIT_FACTOR;
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
  intervalMs = 25,
): Promise<void> {
  const effective = timeoutMs * WAIT_FACTOR;
  const deadline = Date.now() + effective;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(intervalMs);
  }
  throw new Error(`waitFor: condition not met within ${String(effective)} ms`);
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
      ws.on('message', (data, isBinary) => {
        if (isBinary) return;
        handler(typeof data === 'string' ? data : Buffer.from(data as Buffer).toString('utf8'));
      });
    },
    sendBinary: (data) => {
      ws.send(data, { binary: true });
    },
    onBinary: (handler) => {
      ws.on('message', (data, isBinary) => {
        if (!isBinary) return;
        handler(Buffer.isBuffer(data) ? data : Buffer.concat(data as Buffer[]));
      });
    },
    bufferedAmount: () => ws.bufferedAmount,
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

/**
 * tar.gz minimal (mêmes entrées que `buildZip` : nom finissant par `/` = dossier) pour les tests
 * d'archives sur les plateformes où `archiveFor(os)` vaut `tar.gz` (Linux, macOS).
 */
export function buildTarGz(entries: { name: string; data: Buffer; deflate?: boolean }[]): Buffer {
  const blocks: Buffer[] = [];
  for (const e of entries) {
    const dir = e.name.endsWith('/');
    const header = Buffer.alloc(512);
    header.write(e.name, 0, 100, 'utf8');
    header.write('0000755', 100, 8, 'ascii'); // mode (bin/java doit être exécutable)
    header.write('0000000', 108, 8, 'ascii'); // uid
    header.write('0000000', 116, 8, 'ascii'); // gid
    header.write(e.data.length.toString(8).padStart(11, '0'), 124, 12, 'ascii');
    header.write('00000000000', 136, 12, 'ascii'); // mtime
    header.write(dir ? '5' : '0', 156, 1, 'ascii'); // typeflag
    header.write('ustar', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    header.fill(' ', 148, 156); // checksum : espaces pendant le calcul
    let sum = 0;
    for (const b of header) sum += b;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    blocks.push(header);
    if (!dir && e.data.length > 0) {
      blocks.push(e.data);
      const pad = 512 - (e.data.length % 512);
      if (pad < 512) blocks.push(Buffer.alloc(pad));
    }
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

/** Zip minimal (entrées `store` ou `deflate`) pour les tests d'archives. */
export function buildZip(entries: { name: string; data: Buffer; deflate?: boolean }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  const crcTable = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (buf: Buffer): number => {
    let c = 0xffffffff;
    for (const b of buf) c = (crcTable[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const method = e.deflate ? 8 : 0;
    const payload = e.deflate ? deflateRawSync(e.data) : e.data;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(e.data), 14);
    local.writeUInt32LE(payload.byteLength, 18);
    local.writeUInt32LE(e.data.byteLength, 22);
    local.writeUInt16LE(name.byteLength, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc32(e.data), 16);
    central.writeUInt32LE(payload.byteLength, 20);
    central.writeUInt32LE(e.data.byteLength, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, payload);
    centrals.push(central, name);
    offset += local.byteLength + name.byteLength + payload.byteLength;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.byteLength, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
