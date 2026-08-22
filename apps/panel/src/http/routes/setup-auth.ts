/** Wizard first-run (doc 03 §8) et sessions (login/logout/me). */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { generateKeyPairSync } from 'node:crypto';
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
import { SETTING_KEYS } from '../../services/settings.js';
import { toUserDto } from '../../services/users.js';
import { RateLimiter } from '../../util/rate-limit.js';
import { clearSessionCookie, requireUser, setSessionCookie } from '../auth.js';

export function auditMeta(request: FastifyRequest) {
  return {
    userId: request.user?.id,
    username: request.user?.username,
    ip: request.ip,
  };
}

/** Clés VAPID (P-256) générées localement — aucune dépendance (`web-push` arrivera avec le push). */
export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pub = publicKey.export({ format: 'jwk' });
  const priv = privateKey.export({ format: 'jwk' });
  const x = Buffer.from(String(pub.x), 'base64url');
  const y = Buffer.from(String(pub.y), 'base64url');
  const raw = Buffer.concat([Buffer.from([0x04]), x, y]);
  return { publicKey: raw.toString('base64url'), privateKey: String(priv.d) };
}

export function registerSetupAndAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const loginLimiter = new RateLimiter({ max: 10, windowMs: 60_000, now: ctx.now });

  r.get(
    '/api/setup/status',
    { config: { public: true }, schema: { response: { 200: setupStatusSchema } } },
    () => ({ needsSetup: ctx.users.count() === 0 }),
  );

  r.post(
    '/api/setup',
    { config: { public: true }, schema: { body: setupRequestSchema } },
    async (request, reply) => {
      if (ctx.users.count() > 0) {
        throw new AppError('E_SETUP_DONE', 'setup already completed');
      }
      const body = request.body;
      const admin = await ctx.users.create({
        username: body.username,
        password: body.password,
        role: 'admin',
        locale: body.locale,
      });
      const vapid = generateVapidKeys();
      ctx.settings.set(SETTING_KEYS.vapidPublicKey, vapid.publicKey);
      ctx.settings.set(SETTING_KEYS.vapidPrivateKey, vapid.privateKey);
      if (body.publicUrl !== undefined)
        ctx.settings.set(SETTING_KEYS.publicUrl, body.publicUrl.replace(/\/+$/, ''));
      if (body.accessMode !== undefined) ctx.settings.set(SETTING_KEYS.accessMode, body.accessMode);
      if (body.backupDestination !== undefined) {
        ctx.settings.set(SETTING_KEYS.backupDestination, body.backupDestination);
      }
      ctx.settings.set(SETTING_KEYS.setupCompletedAt, String(ctx.now()));
      ctx.audit.record({
        userId: admin.id,
        username: admin.username,
        action: 'setup.completed',
        targetType: 'user',
        targetId: admin.id,
        ip: request.ip,
      });
      const session = ctx.sessions.create(admin.id, {
        ip: request.ip,
        userAgent: request.headers['user-agent'],
      });
      setSessionCookie(ctx, reply, session.token, session.expiresAt);
      return reply.code(201).send({ user: toUserDto(admin) });
    },
  );

  r.post(
    '/api/auth/login',
    { config: { public: true }, schema: { body: loginRequestSchema } },
    async (request, reply) => {
      const key = `${request.ip}|${request.body.username.toLowerCase()}`;
      if (!loginLimiter.hit(key)) {
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
