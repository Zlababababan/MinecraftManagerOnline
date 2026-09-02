import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProtocolError } from '../errors.js';
import { IdempotencyCache } from './idempotency.js';
import { createRpcPeer, type RpcPeer, type RpcTransport } from './peer.js';
import { ulid, ulidTime } from './ulid.js';

/** Paire de transports en mémoire, livraison asynchrone (microtask), coupure simulable. */
function memoryPair(): { a: RpcTransport & Controls; b: RpcTransport & Controls } {
  const make = (): RpcTransport & Controls => {
    const t: RpcTransport & Controls = {
      peer: undefined,
      messageHandler: undefined,
      closeHandler: undefined,
      sent: [],
      dropNext: 0,
      failSend: false,
      send(data) {
        // Socket coupé sans `close` encore délivré : c'est ce que fait le transport WebSocket.
        if (t.failSend) throw new Error('websocket not open');
        t.sent.push(data);
        if (t.dropNext > 0) {
          t.dropNext--;
          return;
        }
        const target = t.peer;
        queueMicrotask(() => target?.messageHandler?.(data));
      },
      onMessage(h) {
        t.messageHandler = h;
      },
      onClose(h) {
        t.closeHandler = h;
      },
      close(reason) {
        t.closeHandler?.(reason);
      },
    };
    return t;
  };
  const a = make();
  const b = make();
  a.peer = b;
  b.peer = a;
  return { a, b };
}
interface Controls {
  peer: (RpcTransport & Controls) | undefined;
  messageHandler: ((data: string) => void) | undefined;
  closeHandler: ((reason?: string) => void) | undefined;
  sent: string[];
  dropNext: number;
  /** `send` lève « websocket not open » (socket coupé, `close` pas encore délivré). */
  failSend: boolean;
  close(reason?: string): void;
}

describe('ulid', () => {
  it('produit 26 caractères Crockford et encode le temps', () => {
    const now = 1787330455000;
    const id = ulid(now);
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(ulidTime(id)).toBe(now);
    expect(ulid()).not.toBe(ulid());
  });
});

describe('IdempotencyCache', () => {
  it('expire après le TTL et borne le nombre d’entrées', () => {
    let now = 0;
    const cache = new IdempotencyCache<string>({ ttlMs: 100, maxEntries: 2, now: () => now });
    cache.set('a', '1');
    cache.set('b', '2');
    cache.set('c', '3');
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe('2');
    expect(cache.size).toBe(2);
    now = 150;
    expect(cache.get('c')).toBeUndefined();
  });
});

describe('RpcPeer', () => {
  let panel: RpcPeer<'panel'>;
  let agent: RpcPeer<'agent'>;
  let transports: ReturnType<typeof memoryPair>;
  const warnings: string[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    transports = memoryPair();
    const logger = { warn: (m: string) => void warnings.push(m) };
    panel = createRpcPeer({
      role: 'panel',
      transport: transports.a,
      logger,
      userIdProvider: () => 'user_1',
    });
    agent = createRpcPeer({ role: 'agent', transport: transports.b, logger });
  });
  afterEach(() => {
    vi.useRealTimers();
    warnings.length = 0;
  });

  it('requête typée panel → agent, réponse validée', async () => {
    agent.handle('server.start', (payload, ctx) => {
      expect(payload.serverId).toBe('srv_01');
      expect(ctx.userId).toBe('user_1');
      return { alreadyRunning: false, pid: 4242 };
    });
    const res = await panel.request('server.start', { serverId: 'srv_01' });
    expect(res).toEqual({ alreadyRunning: false, pid: 4242 });
    const sent = JSON.parse(transports.a.sent[0] ?? '{}') as Record<string, unknown>;
    expect(sent).toMatchObject({
      v: 1,
      kind: 'req',
      type: 'server.start',
      userId: 'user_1',
      deadlineMs: 30000,
    });
  });

  it('requête agent → panel (canal full-duplex)', async () => {
    panel.handle('auth.hello', (payload) => ({
      protocolVersion: Math.min(1, payload.protoMax),
      heartbeatIntervalSec: 15,
      wantFullSync: true,
    }));
    const res = await agent.request('auth.hello', {
      agentId: 'a1',
      agentSecret: 's',
      agentVersion: '1.0.0',
      protoMin: 1,
      protoMax: 1,
      capabilities: ['zstd'],
    });
    expect(res.protocolVersion).toBe(1);
    expect(res.subscriptions).toEqual([]); // défaut appliqué par le schéma
  });

  it('type inconnu → E_UNSUPPORTED_TYPE sans déconnexion', async () => {
    const bogus = JSON.stringify({
      v: 1,
      kind: 'req',
      id: ulid(),
      type: 'backup.create',
      ts: 1,
      payload: {},
    });
    transports.a.send(bogus);
    await vi.advanceTimersByTimeAsync(0);
    const reply = JSON.parse(transports.b.sent.at(-1) ?? '{}') as {
      ok: boolean;
      error?: { code: string };
    };
    expect(reply.ok).toBe(false);
    expect(reply.error?.code).toBe('E_UNSUPPORTED_TYPE');
    expect(agent.isClosed).toBe(false);
  });

  it('payload invalide → E_INVALID_PAYLOAD avec les issues', async () => {
    agent.handle('server.stop', () => ({}));
    await expect(
      panel.request('server.stop', { serverId: 'srv_01', timeoutSec: -5 }),
    ).rejects.toMatchObject({ code: 'E_INVALID_PAYLOAD', details: { type: 'server.stop' } });
  });

  it('handler qui lève une ProtocolError → code transmis ; erreur inattendue → E_INTERNAL', async () => {
    agent.handle('server.start', () => {
      throw new ProtocolError('E_EULA_REQUIRED', 'eula not accepted', {
        details: { path: 'eula.txt' },
      });
    });
    agent.handle('server.kill', () => {
      throw new Error('boom');
    });
    await expect(panel.request('server.start', { serverId: 'x' })).rejects.toMatchObject({
      code: 'E_EULA_REQUIRED',
      retryable: false,
      details: { path: 'eula.txt' },
    });
    await expect(panel.request('server.kill', { serverId: 'x' })).rejects.toMatchObject({
      code: 'E_INTERNAL',
      message: 'boom',
    });
  });

  it('réponse de handler non conforme → E_INTERNAL (jamais de payload invalide sur le fil)', async () => {
    agent.handle(
      'server.kill',
      () => ({ wasRunning: 'yes' }) as unknown as { wasRunning: boolean },
    );
    await expect(panel.request('server.kill', { serverId: 'x' })).rejects.toMatchObject({
      code: 'E_INTERNAL',
    });
  });

  it('timeout → E_TIMEOUT réessayable', async () => {
    agent.handle('server.start', () => new Promise(() => undefined));
    const p = panel.request('server.start', { serverId: 'x' }, { deadlineMs: 1000 });
    const assertion = expect(p).rejects.toMatchObject({ code: 'E_TIMEOUT', retryable: true });
    await vi.advanceTimersByTimeAsync(1001);
    await assertion;
    expect(panel.pendingCount).toBe(0);
  });

  it('idempotence : rejeu du même id → réponse du cache, handler exécuté une seule fois', async () => {
    let calls = 0;
    agent.handle('server.start', () => {
      calls++;
      return { pid: 1 };
    });
    const id = ulid();
    const r1 = await panel.request('server.start', { serverId: 'x' }, { id });
    const r2 = await panel.request('server.start', { serverId: 'x' }, { id });
    expect(r1).toEqual(r2);
    expect(calls).toBe(1);
  });

  it('réponse perdue puis rejeu avec le même id → même réponse sans ré-exécution', async () => {
    let calls = 0;
    agent.handle('server.start', () => {
      calls++;
      return { pid: 7 };
    });
    const id = ulid();
    transports.b.dropNext = 1; // la réponse de l'agent se perd
    const first = panel.request('server.start', { serverId: 'x' }, { id, deadlineMs: 500 });
    const firstAssertion = expect(first).rejects.toMatchObject({ code: 'E_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(501);
    await firstAssertion;
    const second = await panel.request('server.start', { serverId: 'x' }, { id });
    expect(second).toEqual({ pid: 7 });
    expect(calls).toBe(1);
  });

  it('événements : émission typée, id automatique pour les critiques, handlers multiples', async () => {
    const seen: string[] = [];
    panel.on('server.stateChanged', (payload, ctx) => {
      seen.push(`${payload.state}:${ctx.id ?? 'none'}`);
    });
    panel.on('console.lines', (payload, ctx) => {
      seen.push(`lines:${String(payload.lines.length)}:${ctx.id ?? 'none'}`);
    });
    const eventId = ulid();
    const id = agent.emit('server.stateChanged', {
      eventId,
      serverId: 'srv_01',
      ts: 1,
      state: 'running',
    });
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(
      agent.emit('console.lines', {
        serverId: 'srv_01',
        lines: [{ seq: 1, ts: 1, level: 'INFO', text: 'x' }],
      }),
    ).toBeUndefined();
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([`running:${id ?? ''}`, 'lines:1:none']);
  });

  it('événement invalide ou inconnu → ignoré avec avertissement', async () => {
    panel.on('metrics.sample', () => {
      throw new Error('should not be called');
    });
    transports.b.send(
      JSON.stringify({ v: 1, kind: 'event', type: 'metrics.sample', ts: 1, payload: { ts: 'x' } }),
    );
    transports.b.send(
      JSON.stringify({ v: 1, kind: 'event', type: 'future.event', ts: 1, payload: {} }),
    );
    transports.b.send('not json');
    await vi.advanceTimersByTimeAsync(0);
    expect(warnings.length).toBeGreaterThanOrEqual(3);
  });

  it('fermeture du transport → requêtes en attente rejetées E_INTERRUPTED, nouvelles refusées', async () => {
    agent.handle('server.start', () => new Promise(() => undefined));
    const p = panel.request('server.start', { serverId: 'x' });
    const assertion = expect(p).rejects.toMatchObject({ code: 'E_INTERRUPTED', retryable: true });
    transports.a.close('ws closed');
    await assertion;
    await expect(panel.request('server.start', { serverId: 'x' })).rejects.toMatchObject({
      code: 'E_INTERRUPTED',
    });
    expect(panel.isClosed).toBe(true);
  });

  it('pair parti avant la réponse → réponse abandonnée avec avertissement, jamais une promesse rejetée', async () => {
    // Vécu en CI Windows (phase 8) : l'agent s'arrête entre l'exécution d'une requête et sa
    // réponse ; le transport lève « websocket not open » et `receive` produisait une promesse
    // rejetée que personne n'attendait — vitest la comptait comme une erreur du run.
    let release: () => void = () => undefined;
    agent.handle(
      'server.start',
      () =>
        new Promise((resolve) => {
          release = () => {
            resolve({ alreadyRunning: false, pid: 1 });
          };
        }),
    );
    const request = panel.request('server.start', { serverId: 'srv_01' }, { deadlineMs: 1000 });
    const swallowed = request.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);
    transports.b.failSend = true;
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(warnings).toContain('rpc: response dropped, transport closed');
    // Même règle pour une réponse d'erreur immédiate (enveloppe malformée) : aucune exception.
    transports.b.messageHandler?.(
      JSON.stringify({ kind: 'req', id: ulid(), type: 'server.start' }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(warnings.filter((w) => w === 'rpc: response dropped, transport closed')).toHaveLength(2);
    expect(warnings).not.toContain('rpc: receive failed');
    // Le demandeur, lui, finit en timeout : c'est son affaire de rejouer après reconnexion.
    await vi.advanceTimersByTimeAsync(1000);
    expect(await swallowed).toMatchObject({ code: 'E_TIMEOUT' });
  });

  it('enveloppe malformée avec id → réponse E_INVALID_PAYLOAD', async () => {
    transports.a.send(JSON.stringify({ kind: 'req', id: ulid(), type: 'server.start' }));
    await vi.advanceTimersByTimeAsync(0);
    const reply = JSON.parse(transports.b.sent.at(-1) ?? '{}') as {
      ok: boolean;
      error?: { code: string };
    };
    expect(reply.ok).toBe(false);
    expect(reply.error?.code).toBe('E_INVALID_PAYLOAD');
  });
});
