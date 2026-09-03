/**
 * Journal d'accès corrélé (lot 9). La journalisation des requêtes de Fastify est désactivée
 * (deux lignes par requête, sans utilisateur ni durée) et le panel n'écrivait qu'une quinzaine de
 * lignes `info` en tout : son journal fichier était quasi vide, et une erreur 500 renvoyait un
 * `requestId` que rien ne permettait de retrouver.
 *
 * Une ligne par réponse sur la surface API/distribution, **sans la query string** (elle peut porter
 * un chemin, un pseudo, un motif de recherche) : identifiant de requête (ULID, celui que le 500
 * renvoie dans `details.requestId`), méthode, motif de route, statut, durée, utilisateur, adresse.
 * `warn` au-delà d'une seconde ou dès 500 ; `debug` pour la sonde de santé anonyme, sinon les
 * healthchecks (Docker, installeurs, toutes les 30 s) noieraient le journal.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';

/** Une requête plus lente que ça mérite un `warn` : c'est le seuil « quelque chose bloque ». */
export const SLOW_REQUEST_MS = 1000;

export interface AccessLogOptions {
  slowMs?: number;
}

/** Surface journalisée : l'API, les WebSockets et les fichiers de distribution — pas le front. */
export function isLoggedPath(pathname: string): boolean {
  return (
    pathname.startsWith('/api/') ||
    pathname.startsWith('/ws/') ||
    pathname.startsWith('/dist/') ||
    pathname === '/install.sh' ||
    pathname === '/install.ps1'
  );
}

function pathnameOf(request: FastifyRequest): string {
  const url = request.raw.url ?? request.url;
  const q = url.indexOf('?');
  return q < 0 ? url : url.slice(0, q);
}

export function registerAccessLog(app: FastifyInstance, options: AccessLogOptions = {}): void {
  const slowMs = options.slowMs ?? SLOW_REQUEST_MS;
  app.addHook('onResponse', (request, reply, done) => {
    const pathname = pathnameOf(request);
    if (!isLoggedPath(pathname)) {
      done();
      return;
    }
    const durationMs = Math.round(reply.elapsedTime);
    const status = reply.statusCode;
    const level =
      status >= 500 || durationMs >= slowMs
        ? 'warn'
        : pathname === '/api/health' && request.user === undefined
          ? 'debug'
          : 'info';
    request.log[level](
      {
        requestId: request.id,
        method: request.method,
        // Motif de route quand le routeur en a un (`/api/servers/:id`), sinon le chemin seul.
        route: request.routeOptions.url ?? pathname,
        status,
        durationMs,
        ...(request.user === undefined ? {} : { user: request.user.username }),
        ...(request.apiKey === undefined ? {} : { apiKey: request.apiKey.prefix }),
        ip: request.ip,
      },
      'request',
    );
    done();
  });
}
