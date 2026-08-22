/**
 * Service du front buildé (`apps/web/dist`, doc 03 §1 « sert le front buildé ») : fichiers
 * statiques + fallback SPA (`index.html`) pour toute navigation hors `/api` et `/ws`.
 * `index.html`, `sw.js` et le manifest ne sont jamais mis en cache (mise à jour PWA immédiate) ;
 * les assets hachés de `/assets/` sont immuables.
 */
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { existsSync } from 'node:fs';
import path from 'node:path';

const NO_CACHE =
  /(?:^|\/)(?:index\.html|sw\.js|registerSW\.js|manifest\.webmanifest|workbox-[^/]+\.js)$/;

export function isApiOrWs(url: string): boolean {
  return url === '/api' || url.startsWith('/api/') || url === '/ws' || url.startsWith('/ws/');
}

/** Requête de navigation (HTML attendu) hors API/WS → `index.html`. */
export function wantsSpaFallback(
  request: Pick<FastifyRequest, 'method' | 'url' | 'headers'>,
): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  const pathname = request.url.split('?')[0] ?? '';
  if (isApiOrWs(pathname)) return false;
  const accept = request.headers.accept ?? '';
  return accept.includes('text/html') || accept === '' || accept.includes('*/*');
}

export async function registerStatic(
  app: FastifyInstance,
  webDir: string | undefined,
): Promise<boolean> {
  if (webDir === undefined || !existsSync(path.join(webDir, 'index.html'))) return false;
  await app.register(fastifyStatic, {
    root: webDir,
    prefix: '/',
    index: ['index.html'],
    wildcard: true,
    cacheControl: false,
    setHeaders: (res, filePath) => {
      const rel = filePath.replaceAll('\\', '/');
      if (NO_CACHE.test(rel)) void res.header('cache-control', 'no-cache');
      else if (rel.includes('/assets/'))
        void res.header('cache-control', 'public, max-age=31536000, immutable');
      else void res.header('cache-control', 'public, max-age=3600');
    },
  });
  return true;
}

export function sendIndex(reply: FastifyReply): FastifyReply {
  return reply.header('cache-control', 'no-cache').sendFile('index.html');
}
