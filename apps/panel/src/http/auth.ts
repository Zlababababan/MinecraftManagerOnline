/**
 * Authentification HTTP (doc 03 §6) : cookie de session `mmo_session` (httpOnly, SameSite=Lax,
 * Secure en https), `request.user`, refus par défaut (toute route non `public` exige une session),
 * RBAC par `config.role` (admin > operator > viewer). Wizard first-run : tant qu'aucun utilisateur
 * n'existe, les routes protégées répondent `E_AUTH` avec `details.setupRequired = true`.
 * Lot 8 : sur les routes `/api/servers/:id…` et `/api/machines/:id…`, le rôle jugé est le rôle
 * effectif de l'utilisateur sur cette portée (`services/permissions.ts`) ; hors portée → 404.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { Role } from '@mmo/protocol/client';

import type { AppContext } from '../context.js';
import type { UserRow } from '../db/schema.js';
import { AppError, forbidden, notFound } from '../errors.js';
import { routeScope } from '../services/permissions.js';
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

/** /api ou /ws selon le motif de route, l'URL brute ou l'URL décodée (déni par défaut au doute). */
export function isProtectedRequest(request: Pick<FastifyRequest, 'url' | 'routeOptions'>): boolean {
  const raw = request.url.split('?')[0] ?? '';
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return true;
  }
  return isApiOrWs(raw) || isApiOrWs(decoded) || isApiOrWs(request.routeOptions.url ?? '');
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
    // Phase 12 : la décision se prend sur le **motif de route** (`routeOptions.url`, après
    // décodage par le routeur) et sur l'URL décodée — jamais sur l'URL brute seule :
    // `GET /%61pi/settings` était routé vers `/api/settings` sans session.
    if (config.public === true || !isProtectedRequest(request)) {
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
    // Lot 8 : sur une route qui porte un serveur ou une machine (`/api/servers/:id…`,
    // `/api/machines/:id…` — `request.params` est déjà rempli par le routeur à ce stade), le rôle
    // jugé est le rôle EFFECTIF de l'utilisateur sur cette portée : son rôle global s'il n'est
    // pas limité, le rôle accordé sinon. Portée invisible → 404, comme si elle n'existait pas
    // (aucune énumération possible). Hors portée, le rôle global vaut comme avant.
    const scope = routeScope(request.routeOptions.url ?? '', request.params);
    const snapshot = ctx.permissions.snapshot(request.user.id);
    const effective =
      scope === undefined ? request.user.role : ctx.permissions.roleOn(snapshot, scope);
    if (effective === null) {
      void reply.code(404).send(notFound(scope?.kind ?? 'resource', scope?.id).toJSON());
      return;
    }
    if (!hasRole(effective, role)) {
      void reply.code(403).send(forbidden(`role ${role} required`).toJSON());
      return;
    }
    done();
  });
}
