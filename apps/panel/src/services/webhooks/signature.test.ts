/** Lot 4 — signature HMAC des envois JSON : ce qu'un récepteur doit accepter et refuser. */
import { describe, expect, it } from 'vitest';

import { newWebhookSecret, signWebhook, verifyWebhookSignature } from './signature.js';

const T = 1_700_000_000_000;

describe('signature des webhooks', () => {
  it('signe le corps brut ; refuse un corps altéré, un autre secret, un timestamp hors tolérance, un en-tête malformé', () => {
    const secret = newWebhookSecret();
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    const body = Buffer.from('{"a":1}');
    const header = signWebhook(secret, T, body);
    expect(header).toMatch(/^t=1700000000000,v1=[0-9a-f]{64}$/);
    expect(verifyWebhookSignature(secret, header, body, { now: T + 60_000 })).toBe(true);
    expect(verifyWebhookSignature(secret, header, '{"a":1}', { now: T - 60_000 })).toBe(true);
    expect(verifyWebhookSignature(secret, header, Buffer.from('{"a":2}'), { now: T })).toBe(false);
    expect(verifyWebhookSignature(newWebhookSecret(), header, body, { now: T })).toBe(false);
    expect(verifyWebhookSignature(secret, header, body, { now: T + 6 * 60_000 })).toBe(false);
    expect(
      verifyWebhookSignature(secret, header, body, { now: T + 6 * 60_000, toleranceMs: 600_000 }),
    ).toBe(true);
    expect(verifyWebhookSignature(secret, undefined, body, { now: T })).toBe(false);
    expect(verifyWebhookSignature(secret, 't=abc,v1=zz', body, { now: T })).toBe(false);
    expect(verifyWebhookSignature(secret, `t=${String(T)}`, body, { now: T })).toBe(false);
  });
});
