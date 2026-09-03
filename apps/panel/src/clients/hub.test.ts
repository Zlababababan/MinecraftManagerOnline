/**
 * Lot 9 — contre-pression vers les navigateurs : un socket dont `bufferedAmount` grimpe voit ses
 * messages de faible valeur abandonnés, puis est fermé ; les états et événements passent toujours.
 */
import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';

import type { ServerMessage, UserDto } from '@mmo/protocol/client';

import { CLOSE_PERMISSIONS_CHANGED, ClientHub } from './hub.js';

const USER: UserDto = {
  id: 'u1',
  username: 'admin',
  role: 'admin',
  locale: 'fr',
  theme: 'dark',
  isActive: true,
  createdAt: 0,
  lastLoginAt: null,
  scoped: false,
};

interface Closed {
  code: number | undefined;
  reason: string | undefined;
}

/** Faux socket : `bufferedAmount` piloté par le test, envois et fermetures enregistrés. */
function fakeSocket(): {
  ws: WebSocket;
  sent: ServerMessage[];
  closed: Closed[];
  buffered: { value: number };
} {
  const sent: ServerMessage[] = [];
  const closed: Closed[] = [];
  const buffered = { value: 0 };
  const ws = {
    OPEN: 1,
    readyState: 1,
    get bufferedAmount() {
      return buffered.value;
    },
    send: (data: string) => {
      sent.push(JSON.parse(data) as ServerMessage);
    },
    close: (code?: number, reason?: string) => {
      closed.push({ code, reason });
    },
    on: () => undefined,
  } as unknown as WebSocket;
  return { ws, sent, closed, buffered };
}

function makeHub() {
  const warn = vi.fn();
  const hub = new ClientHub({
    logger: { warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() } as never,
    now: () => 1_787_300_000_000,
    onSubscribe: () => undefined,
    onUnsubscribe: () => undefined,
    backpressure: { dropAboveBytes: 100, closeAboveBytes: 1000 },
  });
  return { hub, warn };
}

const SAMPLE: ServerMessage = {
  type: 'metrics.sample',
  machineId: 'm1',
  sample: { ts: 1, servers: [] } as never,
};
const STATE: ServerMessage = { type: 'pong', ts: 1 };

describe('ClientHub — contre-pression', () => {
  it('abandonne les échantillons au-delà du premier seuil, garde les autres messages', () => {
    const { hub, warn } = makeHub();
    const s = fakeSocket();
    const conn = hub.attach(s.ws, USER);
    expect(s.sent.map((m) => m.type)).toEqual(['hello']);

    s.buffered.value = 500;
    conn.send(SAMPLE);
    conn.send(SAMPLE);
    conn.send(STATE);
    expect(s.sent.map((m) => m.type)).toEqual(['hello', 'pong']);
    expect(s.closed).toHaveLength(0);
    // Un seul avertissement par connexion, pas un par message abandonné.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toBe('client falling behind: low-value messages dropped');

    // Le navigateur relit : tout repasse.
    s.buffered.value = 0;
    conn.send(SAMPLE);
    expect(s.sent.at(-1)?.type).toBe('metrics.sample');
  });

  it('ferme le socket au-delà du second seuil, même pour un message de valeur', () => {
    const { hub, warn } = makeHub();
    const s = fakeSocket();
    const conn = hub.attach(s.ws, USER);
    s.buffered.value = 5000;
    conn.send(STATE);
    expect(s.sent.map((m) => m.type)).toEqual(['hello']);
    expect(s.closed).toEqual([{ code: 1013, reason: 'client too slow' }]);
    expect(warn.mock.calls.at(-1)?.[1]).toBe('client not reading: closing (it will reconnect)');
  });

  it('sous les seuils, rien ne change : tout est envoyé', () => {
    const { hub, warn } = makeHub();
    const s = fakeSocket();
    const conn = hub.attach(s.ws, USER);
    s.buffered.value = 100;
    conn.send(SAMPLE);
    conn.send(STATE);
    expect(s.sent.map((m) => m.type)).toEqual(['hello', 'metrics.sample', 'pong']);
    expect(warn).not.toHaveBeenCalled();
  });
});

/** Faux socket qui livre les messages du navigateur au hub (`on('message')`). */
function talkingSocket(): {
  ws: WebSocket;
  sent: ServerMessage[];
  closed: Closed[];
  say: (message: unknown) => void;
} {
  const sent: ServerMessage[] = [];
  const closed: Closed[] = [];
  const handlers = new Map<string, (data: string) => void>();
  const ws = {
    OPEN: 1,
    readyState: 1,
    bufferedAmount: 0,
    send: (data: string) => {
      sent.push(JSON.parse(data) as ServerMessage);
    },
    close: (code?: number, reason?: string) => {
      closed.push({ code, reason });
    },
    on: (event: string, handler: (data: string) => void) => {
      handlers.set(event, handler);
    },
  } as unknown as WebSocket;
  return {
    ws,
    sent,
    closed,
    say: (message) => handlers.get('message')?.(JSON.stringify(message)),
  };
}

describe('ClientHub — droits par serveur (lot 8)', () => {
  const FRIEND: UserDto = { ...USER, id: 'u2', username: 'ami', role: 'viewer' };
  const stateOf = (id: string): ServerMessage => ({
    type: 'server.state',
    server: { id, machineId: 'm1' } as never,
  });

  it('`filter` décide par connexion : le message, une copie retaillée, ou rien', () => {
    const onSubscribe = vi.fn();
    const hub = new ClientHub({
      logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } as never,
      now: () => 1,
      onSubscribe,
      onUnsubscribe: () => undefined,
      filter: (conn, message) => {
        if (conn.user.id !== 'u2') return message;
        if (message.type === 'server.state')
          return message.server.id === 's-ok' ? message : undefined;
        if (message.type === 'metrics.sample')
          return { ...message, sample: { ...message.sample, servers: [] } };
        return message;
      },
    });
    const admin = fakeSocket();
    const friend = fakeSocket();
    hub.attach(admin.ws, USER);
    hub.attach(friend.ws, FRIEND);
    hub.broadcast(stateOf('s-ok'));
    hub.broadcast(stateOf('s-hidden'));
    hub.broadcast({
      type: 'metrics.sample',
      machineId: 'm1',
      sample: { ts: 1, servers: [{ serverId: 's-hidden' }] } as never,
    });
    expect(admin.sent.map((m) => m.type)).toEqual([
      'hello',
      'server.state',
      'server.state',
      'metrics.sample',
    ]);
    expect(friend.sent.map((m) => m.type)).toEqual(['hello', 'server.state', 'metrics.sample']);
    const sample = friend.sent.at(-1);
    expect(sample?.type === 'metrics.sample' && sample.sample.servers).toEqual([]);
    const adminSample = admin.sent.at(-1);
    expect(adminSample?.type === 'metrics.sample' && adminSample.sample.servers).toHaveLength(1);
  });

  it('`canSubscribe` refuse un canal hors portée : erreur E_NOT_FOUND, aucun abonnement, agent jamais sollicité', () => {
    const onSubscribe = vi.fn();
    const hub = new ClientHub({
      logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } as never,
      now: () => 1,
      onSubscribe,
      onUnsubscribe: () => undefined,
      canSubscribe: (conn, channel) => conn.user.id !== 'u2' || channel === 'console:s-ok',
    });
    const s = talkingSocket();
    hub.attach(s.ws, FRIEND);
    s.say({ type: 'subscribe', channels: ['console:s-hidden', 'console:s-ok'] });
    expect(hub.subscriberCount('console:s-hidden')).toBe(0);
    expect(hub.subscriberCount('console:s-ok')).toBe(1);
    expect(onSubscribe).toHaveBeenCalledTimes(1);
    expect(onSubscribe.mock.calls[0]?.[0]).toBe('console:s-ok');
    const error = s.sent.find((m) => m.type === 'error');
    expect(error?.type === 'error' && error.channel).toBe('console:s-hidden');
    expect(error?.type === 'error' && error.error.code).toBe('E_NOT_FOUND');
  });

  it('`disconnectUser` avec le code « droits modifiés » ne ferme que les sockets de ce compte', () => {
    const { hub } = makeHub();
    const admin = fakeSocket();
    const friend = fakeSocket();
    hub.attach(admin.ws, USER);
    hub.attach(friend.ws, FRIEND);
    hub.disconnectUser('u2', 'permissions changed', CLOSE_PERMISSIONS_CHANGED);
    expect(friend.closed).toEqual([{ code: 4002, reason: 'permissions changed' }]);
    expect(admin.closed).toHaveLength(0);
  });
});
