/**
 * Outils de test : panel en mémoire (`:memory:` × 2, migrations rejouées from scratch), horloge
 * pilotable, wizard + cookie, faux agent (client `ws` + `RpcPeer` rôle `agent`), attente.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

import {
  PROTOCOL_VERSION,
  createRpcPeer,
  type Compression,
  type RpcPeer,
  type RpcTransport,
} from '@mmo/protocol';

import { buildApp, type AppOptions, type PanelApp } from '../app.js';

export class TestClock {
  private t: number;
  constructor(start = 1_787_300_000_000) {
    this.t = start;
  }
  now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
  set(ts: number): void {
    this.t = ts;
  }
}

export interface TestPanel extends PanelApp {
  clock: TestClock;
  /** Renseigné après `listen()`. */
  baseUrl: string;
  wsUrl: string;
  listen(): Promise<void>;
}

export async function createTestPanel(options: AppOptions = {}): Promise<TestPanel> {
  const clock = new TestClock();
  const panel = await buildApp({
    dbFile: ':memory:',
    metricsFile: ':memory:',
    now: clock.now,
    ...options,
    config: { mojangManifest: false, ...options.config },
  });
  const test: TestPanel = {
    ...panel,
    clock,
    baseUrl: '',
    wsUrl: '',
    listen: async () => {
      const port = await freePort();
      await panel.app.listen({ port, host: '127.0.0.1' });
      test.baseUrl = `http://127.0.0.1:${String(port)}`;
      test.wsUrl = `ws://127.0.0.1:${String(port)}`;
    },
  };
  return test;
}

export function cookieFrom(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie'];
  const first: unknown = Array.isArray(raw) ? raw[0] : raw;
  return String(first).split(';')[0] ?? '';
}

/** Exécute le wizard et retourne le cookie admin. */
export async function setupAdmin(
  panel: TestPanel,
  credentials = { username: 'admin', password: 'correct horse battery' },
): Promise<string> {
  const res = await panel.app.inject({ method: 'POST', url: '/api/setup', payload: credentials });
  if (res.statusCode !== 201) throw new Error(`setup failed: ${res.body}`);
  return cookieFrom(res);
}

export async function login(panel: TestPanel, username: string, password: string): Promise<string> {
  const res = await panel.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password },
  });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.body}`);
  return cookieFrom(res);
}

export async function createUser(
  panel: TestPanel,
  adminCookie: string,
  user: { username: string; password: string; role: 'admin' | 'operator' | 'viewer' },
): Promise<string> {
  const res = await panel.app.inject({
    method: 'POST',
    url: '/api/users',
    payload: user,
    headers: { cookie: adminCookie },
  });
  if (res.statusCode !== 201) throw new Error(`create user failed: ${res.body}`);
  return login(panel, user.username, user.password);
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
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
  prefix = 'mmo-panel-',
): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  return {
    dir,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
    },
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

// --- Faux agent (client WebSocket brut) ----------------------------------------------------------

export type AgentPeer = RpcPeer<'agent'>;

export interface FakeAgent {
  peer: AgentPeer;
  ws: WebSocket;
  closed: Promise<string>;
  close(): Promise<void>;
}

export const MACHINE_INFO = {
  hostname: 'test-host',
  os: 'linux' as const,
  arch: 'x64' as const,
  cpuModel: 'Test CPU',
  cpuCores: 4,
  ramTotalMb: 8192,
};

export function connectFakeAgent(wsUrl: string): Promise<FakeAgent> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsUrl}/ws/agent`);
    const messageHandlers = new Set<(data: string) => void>();
    const closeHandlers = new Set<(reason?: string) => void>();
    const closed = new Promise<string>((resolveClosed) => {
      ws.on('close', (code, reason) => {
        const r = `${String(code)} ${reason.toString()}`.trim();
        for (const h of closeHandlers) h(r);
        resolveClosed(r);
      });
    });
    ws.on('message', (data) => {
      const text = typeof data === 'string' ? data : Buffer.from(data as Buffer).toString('utf8');
      for (const h of messageHandlers) h(text);
    });
    ws.once('error', reject);
    ws.once('open', () => {
      const transport: RpcTransport = {
        send: (d) => {
          ws.send(d);
        },
        onMessage: (h) => {
          messageHandlers.add(h);
        },
        onClose: (h) => {
          closeHandlers.add(h);
        },
      };
      const peer = createRpcPeer({ role: 'agent', transport });
      resolve({
        peer,
        ws,
        closed,
        close: () => {
          ws.close(1000, 'test done');
          return closed.then(() => undefined);
        },
      });
    });
  });
}

export function helloPayload(agentId: string, secret: string, extra: Record<string, unknown> = {}) {
  return {
    agentId,
    agentSecret: secret,
    agentVersion: '0.3.0',
    protoMin: PROTOCOL_VERSION,
    protoMax: PROTOCOL_VERSION,
    capabilities: ['rcon'],
    compression: ['none', 'gzip', 'zstd'] as Compression[],
    machine: MACHINE_INFO,
    ...extra,
  };
}

export function pairPayload(code: string, extra: Record<string, unknown> = {}) {
  return {
    code,
    machine: MACHINE_INFO,
    agentVersion: '0.3.0',
    protoMin: PROTOCOL_VERSION,
    protoMax: PROTOCOL_VERSION,
    ...extra,
  };
}

/** Client navigateur sur `/ws/client` (cookie de session). */
export function connectClient(
  wsUrl: string,
  cookie: string,
): Promise<{ ws: WebSocket; messages: unknown[]; send(msg: unknown): void; close(): void }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsUrl}/ws/client`, { headers: { cookie } });
    const messages: unknown[] = [];
    ws.on('message', (data) => {
      const text = typeof data === 'string' ? data : Buffer.from(data as Buffer).toString('utf8');
      messages.push(JSON.parse(text));
    });
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, res) => {
      reject(new Error(`unexpected response ${String(res.statusCode)}`));
    });
    ws.once('open', () => {
      resolve({
        ws,
        messages,
        send: (msg) => {
          ws.send(JSON.stringify(msg));
        },
        close: () => {
          ws.close();
        },
      });
    });
  });
}
