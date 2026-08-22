/**
 * Transport `RpcTransport` au-dessus du `WebSocket` global de Node (≥ 22, API navigateur — aucune
 * dépendance, donc rien à bundler). Frames texte = enveloppes JSON ; frames binaires = transferts
 * (jalon C), livrées telles quelles aux abonnés `onBinary`.
 */
import type { RpcTransport } from '@mmo/protocol';

/** Sous-ensemble de l'API WebSocket navigateur utilisé par l'agent (permet un faux en test). */
export interface WebSocketLike {
  readonly readyState: number;
  /** Octets en attente d'émission (priorité basse des transferts). */
  readonly bufferedAmount?: number;
  binaryType?: string;
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open', listener: () => void): void;
  addEventListener(
    type: 'close',
    listener: (event: { code: number; reason: string }) => void,
  ): void;
  addEventListener(type: 'error', listener: (event: unknown) => void): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export const WS_OPEN = 1;

export interface WsTransport extends RpcTransport {
  close(code?: number, reason?: string): void;
  readonly isOpen: boolean;
}

/** Enveloppe un socket déjà ouvert. */
export function createWsTransport(ws: WebSocketLike): WsTransport {
  const messageHandlers = new Set<(data: string) => void>();
  const binaryHandlers = new Set<(data: Uint8Array) => void>();
  const closeHandlers = new Set<(reason?: string) => void>();
  let closed = false;
  const onMessage = (data: string): void => {
    for (const h of messageHandlers) h(data);
  };
  const onBinary = (data: Uint8Array): void => {
    for (const h of binaryHandlers) h(data);
  };

  // Frames binaires livrées en ArrayBuffer (pas en Blob) par le WebSocket WHATWG de Node.
  if ('binaryType' in ws) ws.binaryType = 'arraybuffer';
  ws.addEventListener('message', (event) => {
    const { data } = event;
    if (typeof data === 'string') onMessage(data);
    else if (data instanceof ArrayBuffer) onBinary(new Uint8Array(data));
    else if (Buffer.isBuffer(data)) onBinary(data);
    else if (ArrayBuffer.isView(data)) {
      onBinary(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    }
    // Blob ou autre : ignoré
  });
  const fireClose = (reason?: string): void => {
    if (closed) return;
    closed = true;
    for (const h of closeHandlers) h(reason);
  };
  ws.addEventListener('close', (event) => {
    fireClose(`${String(event.code)} ${event.reason}`.trim());
  });
  ws.addEventListener('error', () => {
    // `close` devrait suivre `error` (WHATWG) ; certains runtimes (Node ≤ 22.14) l'omettent.
    fireClose('error');
  });

  return {
    get isOpen() {
      return !closed && ws.readyState === WS_OPEN;
    },
    send(data) {
      if (closed || ws.readyState !== WS_OPEN) throw new Error('websocket not open');
      ws.send(data);
    },
    onMessage(handler) {
      messageHandlers.add(handler);
    },
    sendBinary(data) {
      if (closed || ws.readyState !== WS_OPEN) throw new Error('websocket not open');
      ws.send(data);
    },
    onBinary(handler) {
      binaryHandlers.add(handler);
    },
    bufferedAmount() {
      return ws.bufferedAmount ?? 0;
    },
    onClose(handler) {
      closeHandlers.add(handler);
    },
    close(code, reason) {
      try {
        ws.close(code, reason);
      } catch {
        // déjà fermé
      }
      fireClose(reason);
    },
  };
}

/** Ouvre une connexion ; résout à `open`, rejette si la fermeture/erreur arrive avant. */
export function openWebSocket(
  url: string,
  factory: WebSocketFactory = defaultFactory,
  timeoutMs = 15_000,
): Promise<WebSocketLike> {
  return new Promise((resolve, reject) => {
    const ws = factory(url);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      ws.close();
      reject(new Error(`websocket connect timeout (${url})`));
    }, timeoutMs);
    ws.addEventListener('open', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ws);
    });
    ws.addEventListener('close', (event) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`websocket closed before open (${String(event.code)} ${event.reason})`));
    });
    ws.addEventListener('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`websocket connection failed (${url})`));
    });
  });
}

function defaultFactory(url: string): WebSocketLike {
  return new globalThis.WebSocket(url);
}
