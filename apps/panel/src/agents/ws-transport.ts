/** `RpcTransport` au-dessus d'un socket `ws` côté serveur (frames texte ; binaire = jalon C). */
import type { WebSocket } from 'ws';

import type { AgentTransport } from './session.js';

export function createServerWsTransport(
  ws: WebSocket,
  remoteAddress: string | undefined,
): AgentTransport {
  const messageHandlers = new Set<(data: string) => void>();
  const closeHandlers = new Set<(reason?: string) => void>();
  let closed = false;
  const fireClose = (reason?: string): void => {
    if (closed) return;
    closed = true;
    for (const h of closeHandlers) h(reason);
  };
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    const text = typeof data === 'string' ? data : Buffer.from(data as Buffer).toString('utf8');
    for (const h of messageHandlers) h(text);
  });
  ws.on('close', (code, reason) => {
    fireClose(`${String(code)} ${reason.toString()}`.trim());
  });
  ws.on('error', () => {
    fireClose('error');
  });
  return {
    remoteAddress,
    send(data) {
      if (closed || ws.readyState !== ws.OPEN) throw new Error('websocket not open');
      ws.send(data);
    },
    onMessage(handler) {
      messageHandlers.add(handler);
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
