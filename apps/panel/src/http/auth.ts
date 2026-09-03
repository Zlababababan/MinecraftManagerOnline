/**
 * Authentification HTTP (doc 03 §6) : cookie de session `mmo_session` (httpOnly, SameSite=Lax,
 * Secure en https), `request.user`, refus par défaut (toute route non `public` exige une session),
 * RBAC par `config.role` (admin > operator > viewer). Wizard first-run : tant qu'aucun utilisateur
 * n'existe, les routes protégées répondent `E_AUTH` avec `details.setupRequired = true`.
 * Lot 8 : sur les routes `/api/servers/:id…` et `/api/machines/:id…`, le rôle jugé est le rôle
 * effectif de l'utilisateur sur cette portée (`services/permissions.ts`) ; hors portée → 404.
 * Lot 8 (clés d'API) : sans cookie, un `Authorization: Bearer mmo_…` est tenté sur `/api` seulement ;
 * le rôle est le plus faible entre la clé et son propriétaire, ses portées sont celles du compte,
 * et les routes qui gèrent le compte lui-même (`sessionOnly`) restent réservées au cookie.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { Role } from '@mmo/protocol/client';

import type { AppContext } from '../context.js';
import type { ApiKeyRow, UserRow } from '../db/schema.js';
import { AppError, forbidden, notFound } from '../errors.js';
import { routeScope } from '../services/permissions.js';
import { SETTING_KEYS } from '../services/settings.js';
import { hasRole } from '../services/users.js';
import { RateLimiter, clientKey } from '../util/rate-limit.js';
import { isApiOrWs } from './static.js';

export const SESSION_COOKIE = 'mmo_session';
/** Jetons `Bearer` refusés par adresse et par minute : au-delà, 429 sans même chercher en base. */
export const BAD_API_KEY_LIMIT = { max: 30, windowMs: 60_000 };

declare module 'fastify' {
  interface FastifyRequest {
    user: UserRow | undefined;
    sessionToken: string | undefined;
    /** Id de la session cookie qui authentifie la requête (`undefined` : clé d'API ou anonyme). */
    sessionId: number | undefined;
    /** Clé d'API qui authentifie la requête (`undefined` : cookie ou anonyme). */
    apiKey: ApiKeyRow | undefined;
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

/**
 * Routes réservées au cookie de session : tout ce qui gère le compte, les comptes, les clés et les
 * sessions. Une clé d'API ne peut ni changer un mot de passe, ni créer un compte, ni fabriquer une
 * autre clé — sinon une clé `viewer` volée deviendrait un accès durable. Seul `GET /api/auth/me`
 * (« qui suis-je ») reste ouvert aux clés.
 */
export function sessionOnly(method: string, routeUrl: string): boolean {
  if (routeUrl === '/api/auth/me') return method !== 'GET';
  return (
    routeUrl.startsWith('/api/auth/') ||
    routeUrl.startsWith('/api/users') ||
    routeUrl.startsWith('/api/api-keys') ||
    routeUrl.startsWith('/api/setup')
  );
}

/** `Authorization: Bearer <jeton>` → le jeton ; `undefined` si absent ou d'un autre schéma. */
export function bearerToken(header: string | string[] | undefined): string | undefined {
  if (typeof header !== 'string') return undefined;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1];
}

export function requireUser(request: FastifyRequest): UserRow {
  if (!request.user) throw new AppError('E_AUTH', 'authentication required');
  return request.user;
}

export function registerAuth(app: FastifyInstance, ctx: AppContext): void {
  app.decorateRequest('user', undefined);
  app.decorateRequest('sessionToken', undefined);
  app.decorateRequest('sessionId', undefined);
  app.decorateRequest('apiKey', undefined);
  const badKeyLimiter = new RateLimiter({ ...BAD_API_KEY_LIMIT, now: ctx.now });

  app.addHook('onRequest', (request, reply, done) => {
    const token = request.cookies[SESSION_COOKIE];
    request.sessionToken = token;
    const resolved = ctx.sessions.resolve(token);
    request.user = resolved?.user;
    request.sessionId = resolved?.sessionId;
    const config = request.routeOptions.config;
    const routeUrl = request.routeOptions.url ?? '';
    // Clé d'API : seulement sans cookie (le cookie prime), jamais sur un WebSocket, jamais sur une
    // route publique (login/setup n'ont rien à faire d'une clé). Un jeton refusé compte dans le
    // limiteur par adresse AVANT toute autre décision.
    const bearer =
      request.user === undefined ? bearerToken(request.headers.authorization) : undefined;
    if (bearer !== undefined && config.public !== true && !routeUrl.startsWith('/ws')) {
      const address = clientKey(request.ip);
      if (!badKeyLimiter.hit(address)) {
        void reply.code(429).send(
          new AppError('E_RATE_LIMITED', 'too many rejected API keys', {
            retryable: true,
          }).toJSON(),
        );
        return;
      }
      const viaKey = ctx.apiKeys.resolve(bearer, request.ip);
      if (viaKey === undefined) {
        void reply.code(401).send(
          new AppError('E_AUTH', 'invalid API key', {
            details: { reason: 'INVALID_API_KEY' },
          }).toJSON(),
        );
        return;
      }
      badKeyLimiter.reset(address);
      request.user = viaKey.user;
      request.apiKey = viaKey.key;
      if (sessionOnly(request.method, routeUrl)) {
        void reply.code(403).send(
          new AppError('E_FORBIDDEN', 'this route requires a session, not an API key', {
            details: { reason: 'API_KEY' },
          }).toJSON(),
        );
        return;
      }
    }
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
    // (aucune énumération possible). Hors portée, le rôle global vaut comme avant. Par une clé
    // d'API, `request.user.role` est déjà le plus faible des deux rôles et `snapshotFor` plafonne
    // les portées accordées à ce même rôle.
    const scope = routeScope(routeUrl, request.params);
    const snapshot = ctx.permissions.snapshotFor(request.user);
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
