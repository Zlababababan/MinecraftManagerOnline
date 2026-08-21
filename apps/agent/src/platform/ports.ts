/**
 * Ports TCP : test de disponibilité par tentative d'écoute (garde-fou port, doc 05 §6).
 * Un port est libre si l'écoute réussit **sur IPv4 (0.0.0.0) et sur IPv6 (::)** : sous Windows,
 * un processus lié à `0.0.0.0` n'empêche pas une écoute sur `::` (piles séparées), et Java lie
 * l'une ou l'autre selon la configuration.
 */
import net from 'node:net';

const NOT_APPLICABLE = new Set(['EAFNOSUPPORT', 'EADDRNOTAVAIL', 'EINVAL', 'EPROTONOSUPPORT']);

function canListen(port: number, host: string, ipv6Only: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', (error: NodeJS.ErrnoException) => {
      resolve(NOT_APPLICABLE.has(error.code ?? ''));
    });
    server.listen({ port, host, exclusive: true, ipv6Only }, () => {
      server.close(() => {
        resolve(true);
      });
    });
  });
}

/** `true` si le port est libre sur toutes les interfaces (IPv4 et IPv6). */
export async function isPortFree(port: number, host?: string): Promise<boolean> {
  if (host !== undefined) return canListen(port, host, false);
  return (await canListen(port, '0.0.0.0', false)) && (await canListen(port, '::', true));
}

/** Premier port libre dans `[from, to]`, en évitant `exclude`. */
export async function findFreePort(
  from: number,
  to: number,
  exclude: Iterable<number> = [],
): Promise<number | undefined> {
  const excluded = new Set(exclude);
  for (let port = from; port <= to; port++) {
    if (excluded.has(port)) continue;
    if (await isPortFree(port)) return port;
  }
  return undefined;
}
