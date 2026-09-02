/**
 * Lot 4 — signature des envois JSON : `x-mmo-signature: t=<epoch ms>,v1=<hex>` où
 * `v1 = HMAC-SHA256(secret, "<t>.<corps brut>")`. Le timestamp signé borne le rejeu ; le récepteur
 * recalcule sur le corps TEL QUE REÇU (pas sur un JSON re-sérialisé) et compare en temps constant.
 * `verifyWebhookSignature` est la référence pour qui écrit le récepteur (guide §6).
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'x-mmo-signature';
/** Écart d'horloge toléré entre l'émetteur et le récepteur. */
export const DEFAULT_TOLERANCE_MS = 5 * 60_000;

/** 256 bits en hexadécimal : lisible, copiable, sans caractère que shell ou YAML voudrait citer. */
export function newWebhookSecret(): string {
  return randomBytes(32).toString('hex');
}

function digest(secret: string, ts: number, body: Buffer | string): Buffer {
  return createHmac('sha256', secret)
    .update(`${String(ts)}.`)
    .update(body)
    .digest();
}

export function signWebhook(secret: string, ts: number, body: Buffer | string): string {
  return `t=${String(ts)},v1=${digest(secret, ts, body).toString('hex')}`;
}

export function verifyWebhookSignature(
  secret: string,
  header: string | undefined,
  body: Buffer | string,
  options: { now: number; toleranceMs?: number },
): boolean {
  if (header === undefined) return false;
  const parts = new Map<string, string>();
  for (const piece of header.split(',')) {
    const at = piece.indexOf('=');
    if (at !== -1) parts.set(piece.slice(0, at).trim(), piece.slice(at + 1).trim());
  }
  const ts = Number(parts.get('t'));
  const v1 = parts.get('v1');
  if (!Number.isFinite(ts) || v1 === undefined || !/^[0-9a-f]{64}$/.test(v1)) return false;
  if (Math.abs(options.now - ts) > (options.toleranceMs ?? DEFAULT_TOLERANCE_MS)) return false;
  return timingSafeEqual(digest(secret, ts, body), Buffer.from(v1, 'hex'));
}
