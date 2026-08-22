import { createECDH, createPublicKey, randomBytes, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { generateVapidKeys } from '../../http/routes/setup-auth.js';
import {
  b64url,
  decryptPayload,
  encryptPayload,
  fromB64url,
  sendWebPush,
  vapidAuthorization,
} from './webpush.js';

// RFC 8291, annexe A (vecteur de test complet).
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  uaPublic:
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  output:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

describe('webpush — chiffrement aes128gcm (RFC 8291)', () => {
  it('reproduit le vecteur de test de la RFC', () => {
    const out = encryptPayload(
      Buffer.from(RFC.plaintext),
      { p256dh: RFC.uaPublic, auth: RFC.auth },
      { salt: fromB64url(RFC.salt), serverPrivateKey: fromB64url(RFC.asPrivate) },
    );
    expect(b64url(out)).toBe(RFC.output);
    expect(decryptPayload(out, fromB64url(RFC.uaPrivate), fromB64url(RFC.auth)).toString()).toBe(
      RFC.plaintext,
    );
  });

  it('aller-retour avec des clés aléatoires', () => {
    const ua = createECDH('prime256v1');
    ua.generateKeys();
    const auth = randomBytes(16);
    const payload = Buffer.from(JSON.stringify({ title: 'Crash', body: 'x'.repeat(2000) }));
    const out = encryptPayload(payload, { p256dh: b64url(ua.getPublicKey()), auth: b64url(auth) });
    expect(decryptPayload(out, ua.getPrivateKey(), auth).equals(payload)).toBe(true);
  });

  it('refuse une clé p256dh invalide', () => {
    expect(() => encryptPayload(Buffer.from('x'), { p256dh: 'AAAA', auth: 'AAAA' })).toThrow();
  });
});

describe('webpush — VAPID (RFC 8292)', () => {
  it('signe un JWT ES256 vérifiable avec la clé publique', () => {
    const keys = generateVapidKeys();
    const header = vapidAuthorization(
      'https://fcm.googleapis.com/fcm/send/abc',
      keys,
      'mailto:a@b.c',
      1_700_000_000_000,
    );
    const m = /^vapid t=([^,]+), k=(.+)$/.exec(header);
    expect(m).not.toBeNull();
    const [h, c, sig] = (m?.[1] ?? '').split('.');
    const claims = JSON.parse(fromB64url(c ?? '').toString()) as Record<string, unknown>;
    expect(claims.aud).toBe('https://fcm.googleapis.com');
    expect(claims.sub).toBe('mailto:a@b.c');
    expect(claims.exp).toBe(1_700_000_000 + 12 * 3600);
    expect(m?.[2]).toBe(keys.publicKey);
    const pub = fromB64url(keys.publicKey);
    const publicKey = createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: b64url(pub.subarray(1, 33)), y: b64url(pub.subarray(33)) },
      format: 'jwk',
    });
    expect(
      verify(
        'sha256',
        Buffer.from(`${h ?? ''}.${c ?? ''}`),
        { key: publicKey, dsaEncoding: 'ieee-p1363' },
        fromB64url(sig ?? ''),
      ),
    ).toBe(true);
  });

  it('envoie via fetch et classe les réponses (201 ok, 410 mort, 429 retryable)', async () => {
    const keys = generateVapidKeys();
    const ua = createECDH('prime256v1');
    ua.generateKeys();
    const sub = {
      endpoint: 'https://push.example/send/1',
      keys: { p256dh: b64url(ua.getPublicKey()), auth: b64url(randomBytes(16)) },
    };
    const seen: { headers: Record<string, string>; body: Buffer }[] = [];
    const statuses = [201, 410, 429];
    const fakeFetch: typeof fetch = (_url, init) => {
      const h = (init?.headers ?? {}) as Record<string, string>;
      seen.push({ headers: h, body: Buffer.from(init?.body as Uint8Array) });
      return Promise.resolve(new Response(null, { status: statuses.shift() ?? 500 }));
    };
    const payload = Buffer.from('{"title":"t"}');
    const r1 = await sendWebPush(fakeFetch, sub, payload, keys, Date.now(), { topic: 'crash' });
    const r2 = await sendWebPush(fakeFetch, sub, payload, keys, Date.now());
    const r3 = await sendWebPush(fakeFetch, sub, payload, keys, Date.now());
    expect(r1).toEqual({ ok: true, status: 201 });
    expect(r2).toMatchObject({ ok: false, status: 410, gone: true });
    expect(r3).toMatchObject({ ok: false, status: 429, gone: false, retryable: true });
    const first = seen[0];
    expect(first?.headers['Content-Encoding']).toBe('aes128gcm');
    expect(first?.headers.Topic).toBe('crash');
    expect(first?.headers.Authorization?.startsWith('vapid t=')).toBe(true);
    expect(
      decryptPayload(
        first?.body ?? Buffer.alloc(0),
        ua.getPrivateKey(),
        fromB64url(sub.keys.auth),
      ).equals(payload),
    ).toBe(true);
  });
});
