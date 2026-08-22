import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ServerMessage } from '@mmo/protocol/client';

import { RealtimeClient } from './client.js';

/** Faux WebSocket pilotable (ouverture, messages, fermeture). */
class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: MessageEvent<unknown>) => void) | null = null;
  onclose: ((e: CloseEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent<unknown>);
  }
  drop(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code } as CloseEvent);
  }
}

describe('RealtimeClient', () => {
  beforeEach(() => {
    FakeSocket.instances = [];
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const make = () =>
    new RealtimeClient({
      url: 'ws://test/ws/client',
      factory: (url) => new FakeSocket(url) as unknown as WebSocket,
      backoff: { baseMs: 100, maxMs: 1_000 },
      pingIntervalMs: 10_000,
    });

  it('abonnements comptés, messages validés, statut', () => {
    const client = make();
    const statuses: string[] = [];
    const received: ServerMessage[] = [];
    client.onStatus((s) => statuses.push(s));
    client.on((m) => received.push(m));
    client.connect();
    const ws = FakeSocket.instances[0]!;
    expect(client.status).toBe('connecting');
    const off1 = client.subscribe('console:a');
    const off2 = client.subscribe('console:a');
    expect(ws.sent).toEqual([]); // pas encore ouvert
    ws.open();
    expect(client.status).toBe('open');
    expect(ws.sent).toEqual([{ type: 'subscribe', channels: ['console:a'] }]);
    ws.receive({ type: 'pong', ts: 1 });
    ws.receive({ type: 'garbage' });
    ws.receive({ type: 'server.state', server: { id: 'x' } }); // invalide → ignoré
    expect(received).toEqual([{ type: 'pong', ts: 1 }]);
    off1();
    expect(ws.sent).toHaveLength(1);
    off2();
    off2();
    expect(ws.sent.at(-1)).toEqual({ type: 'unsubscribe', channels: ['console:a'] });
    vi.advanceTimersByTime(10_000);
    expect(ws.sent.at(-1)).toMatchObject({ type: 'ping' });
    expect(statuses).toEqual(['connecting', 'open']);
  });

  it('reconnexion avec backoff et réabonnement', () => {
    const client = make();
    client.connect();
    const first = FakeSocket.instances[0]!;
    client.subscribe('console:a');
    first.open();
    first.drop();
    expect(client.status).toBe('closed');
    expect(FakeSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(150);
    expect(FakeSocket.instances).toHaveLength(2);
    const second = FakeSocket.instances[1]!;
    second.open();
    expect(second.sent).toEqual([{ type: 'subscribe', channels: ['console:a'] }]);
    // Déconnexion volontaire : plus de reconnexion.
    client.disconnect();
    vi.advanceTimersByTime(5_000);
    expect(FakeSocket.instances).toHaveLength(2);
    expect(client.status).toBe('closed');
  });

  it('4001 (session révoquée) : pas de reconnexion', () => {
    const client = make();
    client.connect();
    const ws = FakeSocket.instances[0]!;
    ws.open();
    ws.drop(4001);
    vi.advanceTimersByTime(5_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });
});
