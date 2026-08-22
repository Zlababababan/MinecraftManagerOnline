/**
 * En-têtes de sécurité (phase 12, doc 03 §6) posés sur toutes les réponses : CSP compatible avec le
 * front Vite/Mantine (styles inline, avatars mc-heads.net, WebSocket same-origin, service worker),
 * anti-clickjacking, `nosniff`, referrer borné ; HSTS seulement quand le panel est servi en HTTPS
 * (cookie `Secure`), pour ne pas piéger un accès http://127.0.0.1 en développement.
 */
import type { FastifyInstance } from 'fastify';

import type { AppContext } from '../context.js';
import { cookieSecure } from './auth.js';

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://mc-heads.net",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

export function registerSecurityHeaders(app: FastifyInstance, ctx: AppContext): void {
  app.addHook('onSend', (request, reply, payload, done) => {
    void reply.header('x-content-type-options', 'nosniff');
    void reply.header('x-frame-options', 'DENY');
    void reply.header('referrer-policy', 'same-origin');
    void reply.header('content-security-policy', CONTENT_SECURITY_POLICY);
    if (cookieSecure(ctx) && request.protocol === 'https') {
      void reply.header('strict-transport-security', 'max-age=15552000');
    }
    done(null, payload);
  });
}
