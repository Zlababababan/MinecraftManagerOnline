/** Wizard first-run (doc 03 §8) et sessions (login/logout/me). */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import {
  loginRequestSchema,
  setupRequestSchema,
  setupStatusSchema,
  updateMeSchema,
  userDtoSchema,
} from '@mmo/protocol/client';

import type { AppContext } from '../../context.js';
import { AppError } from '../../errors.js';
import { completeSetup as runSetup } from '../../services/setup.js';
import { toUserDto } from '../../services/users.js';
import { RateLimiter, clientKey } from '../../util/rate-limit.js';
import { clearSessionCookie, requireUser, setSessionCookie } from '../auth.js';

export function auditMeta(request: FastifyRequest) {
  return {
    userId: request.user?.id,
    username: request.user?.username,
    ip: request.ip,
  };
}

/** Réexport historique : l'implémentation vit dans `services/setup.ts`. */
export { generateVapidKeys } from '../../services/setup.js';

export function registerSetupAndAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const loginLimiter = new RateLimiter({ max: 10, windowMs: 60_000, now: ctx.now });
  // Second limiteur par adresse seule : sans lui, 10 tentatives/min PAR NOM D'UTILISATEUR depuis
  // la même adresse revient à ne pas limiter du tout dès qu'on fait varier le nom.
  const loginIpLimiter = new RateLimiter({ max: 30, windowMs: 60_000, now: ctx.now });
  // Phase 12 (doc 03 §6) : un seul POST /api/setup à la fois et 5 tentatives/min par adresse.
  const setupLimiter = new RateLimiter({ max: 5, windowMs: 60_000, now: ctx.now });
  let setupInFlight = false;

  r.get(
    '/api/setup/status',
    { config: { public: true }, schema: { response: { 200: setupStatusSchema } } },
    () => ({ needsSetup: ctx.users.count() === 0 }),
  );

  r.post(
    '/api/setup',
    {
      config: { public: true },
      schema: { body: setupRequestSchema },
      // Avant la validation du corps : un corps invalide compte aussi comme une tentative.
      preValidation: (request, _reply, done) => {
        if (ctx.users.count() > 0) {
          done(new AppError('E_SETUP_DONE', 'setup already completed'));
          return;
        }
        if (!setupLimiter.hit(clientKey(request.ip))) {
          done(new AppError('E_RATE_LIMITED', 'too many setup attempts', { retryable: true }));
          return;
        }
        done();
      },
    },
    async (request, reply) => {
      if (ctx.users.count() > 0) {
        throw new AppError('E_SETUP_DONE', 'setup already completed');
      }
      if (setupInFlight)
        throw new AppError('E_BUSY', 'setup already in progress', { retryable: true });
      setupInFlight = true;
      try {
        return await completeSetup(
          request.body,
          { ip: request.ip, userAgent: request.headers['user-agent'] },
          reply,
        );
      } finally {
        setupInFlight = false;
      }
    },
  );

  /** La configuration elle-même vit dans `services/setup.ts` : `mmo-panel setup` (machine sans
   *  navigateur) emprunte exactement le même chemin, clés VAPID comprises. */
  async function completeSetup(
    body: z.infer<typeof setupRequestSchema>,
    client: { ip: string; userAgent: string | undefined },
    reply: FastifyReply,
  ): Promise<unknown> {
    const admin = await runSetup(ctx, body, { ip: client.ip });
    const session = ctx.sessions.create(admin.id, {
      ip: client.ip,
      userAgent: client.userAgent,
    });
    setSessionCookie(ctx, reply, session.token, session.expiresAt);
    return reply.code(201).send({ user: toUserDto(admin) });
  }

  r.post(
    '/api/auth/login',
    { config: { public: true }, schema: { body: loginRequestSchema } },
    async (request, reply) => {
      const address = clientKey(request.ip);
      const key = `${address}|${request.body.username.toLowerCase()}`;
      if (!loginLimiter.hit(key) || !loginIpLimiter.hit(address)) {
        throw new AppError('E_RATE_LIMITED', 'too many login attempts', { retryable: true });
      }
      const user = await ctx.users.authenticate(request.body.username, request.body.password);
      if (!user) {
        ctx.audit.record({
          action: 'auth.loginFailed',
          details: { username: request.body.username },
          ip: request.ip,
        });
        throw new AppError('E_AUTH', 'invalid credentials');
      }
      loginLimiter.reset(key);
      const session = ctx.sessions.create(user.id, {
        ip: request.ip,
        userAgent: request.headers['user-agent'],
      });
      setSessionCookie(ctx, reply, session.token, session.expiresAt);
      ctx.audit.record({
        userId: user.id,
        username: user.username,
        action: 'auth.login',
        ip: request.ip,
      });
      return { user: toUserDto(user) };
    },
  );

  r.post('/api/auth/logout', { config: { public: true } }, (request, reply) => {
    if (request.sessionToken !== undefined) ctx.sessions.revoke(request.sessionToken);
    clearSessionCookie(ctx, reply);
    if (request.user) ctx.audit.record({ ...auditMeta(request), action: 'auth.logout' });
    return { ok: true };
  });

  r.get(
    '/api/auth/me',
    { schema: { response: { 200: z.object({ user: userDtoSchema }) } } },
    (request) => ({
      user: toUserDto(requireUser(request)),
    }),
  );

  r.patch('/api/auth/me', { schema: { body: updateMeSchema } }, async (request) => {
    const user = requireUser(request);
    const body = request.body;
    if (body.newPassword !== undefined) {
      if (
        body.currentPassword === undefined ||
        !(await ctx.users.verifyPassword(user, body.currentPassword))
      ) {
        throw new AppError('E_AUTH', 'current password is incorrect');
      }
    }
    const updated = await ctx.users.update(user.id, {
      locale: body.locale,
      theme: body.theme,
      password: body.newPassword,
    });
    if (body.newPassword !== undefined) {
      ctx.audit.record({
        ...auditMeta(request),
        action: 'user.passwordChanged',
        targetType: 'user',
        targetId: user.id,
      });
    }
    return { user: toUserDto(updated) };
  });
}
