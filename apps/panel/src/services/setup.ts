/**
 * Configuration initiale du panel, hors de toute route HTTP.
 *
 * Extrait de `http/routes/setup-auth.ts` pour que la ligne de commande (`mmo-panel setup`, pour
 * une machine sans navigateur — VM cloud, conteneur, cloud-init) emprunte **exactement** le même
 * chemin que le wizard. C'est impératif : c'est ici que sont générées les clés VAPID, et une
 * seconde implémentation créerait une installation dont le push est mort sans que rien ne le dise.
 */
import { generateKeyPairSync } from 'node:crypto';

import type { Locale } from '@mmo/shared';

import type { AppContext } from '../context.js';
import { AppError } from '../errors.js';
import { coerceOrigin } from '../util/origin.js';
import { SETTING_KEYS } from './settings.js';
import type { UserRow } from '../db/schema.js';

export interface SetupInput {
  username: string;
  password: string;
  locale?: Locale | undefined;
  publicUrl?: string | undefined;
  accessMode?: 'tailscale' | 'direct' | 'manual' | undefined;
  backupDestination?: string | undefined;
}

/** Clés VAPID (P-256) générées localement — aucune dépendance. */
export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pub = publicKey.export({ format: 'jwk' });
  const priv = privateKey.export({ format: 'jwk' });
  const x = Buffer.from(String(pub.x), 'base64url');
  const y = Buffer.from(String(pub.y), 'base64url');
  const raw = Buffer.concat([Buffer.from([0x04]), x, y]);
  return { publicKey: raw.toString('base64url'), privateKey: String(priv.d) };
}

/**
 * Crée le compte administrateur et pose les réglages initiaux. Tout est validé AVANT la première
 * écriture : un rejet après `users.create` laisserait un setup à moitié fait (compte créé,
 * `setupCompletedAt` absent → retentative en conflit d'identifiant).
 */
export async function completeSetup(
  ctx: AppContext,
  input: SetupInput,
  client: { ip: string } = { ip: 'cli' },
): Promise<UserRow> {
  const origin = input.publicUrl === undefined ? undefined : coerceOrigin(input.publicUrl);
  if (input.publicUrl !== undefined && origin === undefined) {
    throw new AppError('E_VALIDATION', 'publicUrl must be an http(s) origin');
  }
  const admin = await ctx.users.create({
    username: input.username,
    password: input.password,
    role: 'admin',
    locale: input.locale,
  });
  const vapid = generateVapidKeys();
  ctx.settings.set(SETTING_KEYS.vapidPublicKey, vapid.publicKey);
  ctx.settings.set(SETTING_KEYS.vapidPrivateKey, vapid.privateKey);
  if (origin !== undefined) ctx.settings.set(SETTING_KEYS.publicUrl, origin);
  if (input.accessMode !== undefined) ctx.settings.set(SETTING_KEYS.accessMode, input.accessMode);
  if (input.backupDestination !== undefined) {
    ctx.settings.set(SETTING_KEYS.backupDestination, input.backupDestination);
  }
  ctx.settings.set(SETTING_KEYS.setupCompletedAt, String(ctx.now()));
  ctx.audit.record({
    userId: admin.id,
    username: admin.username,
    action: 'setup.completed',
    targetType: 'user',
    targetId: admin.id,
    ip: client.ip,
  });
  return admin;
}
