/**
 * Lot 9 — contre-pression vers les navigateurs : un socket dont `bufferedAmount` grimpe voit ses
 * messages de faible valeur abandonnés, puis est fermé ; les états et événements passent toujours.
 */
import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';

import type { ServerMessage, UserDto } from '@mmo/protocol/client';

import { ClientHub } from './hub.js';

const USER: UserDto = {
  id: 'u1',
  username: 'admin',
  role: 'admin',
  locale: 'fr',
  theme: 'dark',
  isActive: true,
  createdAt: 0,
  lastLoginAt: null,
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
