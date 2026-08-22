/**
 * Authentification HTTP (doc 03 §6) : cookie de session `mmo_session` (httpOnly, SameSite=Lax,
 * Secure en https), `request.user`, refus par défaut (toute route non `public` exige une session),
 * RBAC par `config.role` (admin > operator > viewer). Wizard first-run : tant qu'aucun utilisateur
 * n'existe, les routes protégées répondent `E_AUTH` avec `details.setupRequired = true`.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { Role } from '@mmo/protocol/client';

import type { AppContext } from '../context.js';
import type { UserRow } from '../db/schema.js';
import { AppError, forbidden } from '../errors.js';
import { SETTING_KEYS } from '../services/settings.js';
import { hasRole } from '../services/users.js';
import { isApiOrWs } from './static.js';

export const SESSION_COOKIE = 'mmo_session';

declare module 'fastify' {
  interface FastifyRequest {
    user: UserRow | undefined;
    sessionToken: string | undefined;
  }
  interface FastifyContextConfig {
    /** Route accessible sans session (health, setup, login). */
    public?: boolean;
    /** Rôle minimal requis (défaut : `viewer`, c.-à-d. toute session valide). */
    role?: Role;
  }
}

export function cookieSecure(ctx: AppContext): boolean {
  if (ctx.config.cookieSecure !== undefined) return ctx.config.cookieSecure;
  return (ctx.settings.get(SETTING_KEYS.publicUrl) ?? '').startsWith('https://');
}

export function setSessionCookie(
  ctx: AppContext,
  reply: FastifyReply,
  token: string,
  expiresAt: number,
): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: cookieSecure(ctx),
    path: '/',
    expires: new Date(expiresAt),
  });
}

export function clearSessionCookie(ctx: AppContext, reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: cookieSecure(ctx),
  });
}

export function requireUser(request: FastifyRequest): UserRow {
  if (!request.user) throw new AppError('E_AUTH', 'authentication required');
  return request.user;
}

export function registerAuth(app: FastifyInstance, ctx: AppContext): void {
  app.decorateRequest('user', undefined);
  app.decorateRequest('sessionToken', undefined);

  app.addHook('onRequest', (request, reply, done) => {
    const token = request.cookies[SESSION_COOKIE];
    request.sessionToken = token;
    const resolved = ctx.sessions.resolve(token);
    request.user = resolved?.user;
    const config = request.routeOptions.config;
    // Surface protégée = /api et /ws ; le reste (front statique, fallback SPA) est public.
    if (config.public === true || !isApiOrWs(request.url.split('?')[0] ?? '')) {
      done();
      return;
    }
    if (!request.user) {
      const setupRequired = ctx.users.count() === 0;
      void reply.code(401).send(
        new AppError('E_AUTH', 'authentication required', {
          details: { setupRequired },
        }).toJSON(),
      );
      return;
    }
    const role = config.role ?? 'viewer';
    if (!hasRole(request.user.role, role)) {
      void reply.code(403).send(forbidden(`role ${role} required`).toJSON());
      return;
    }
    done();
  });
}
