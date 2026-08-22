/**
 * Web Push sans dépendance (dérogation doc 03 §1 : pas de `web-push`) :
 * - chiffrement du contenu RFC 8291 (ECDH P-256 + HKDF + AES-128-GCM, encodage `aes128gcm` RFC 8188,
 *   un seul enregistrement) ;
 * - en-tête VAPID RFC 8292 (JWT ES256 signé avec la clé privée `push.vapidPrivateKey`).
 * Tout passe par `node:crypto` ; l'envoi HTTP utilise un `fetch` injectable (tests : faux endpoint).
 */
import {
  createCipheriv,
  createDecipheriv,
  createECDH,
  createPrivateKey,
  hkdfSync,
  randomBytes,
  sign as cryptoSign,
} from 'node:crypto';

export interface PushKeys {
  /** Point P-256 non compressé (65 octets) en base64url. */
  p256dh: string;
  /** Secret d'authentification (16 octets) en base64url. */
  auth: string;
}

export interface VapidKeys {
  /** Point public non compressé, base64url (tel que `generateVapidKeys`). */
  publicKey: string;
  /** Scalaire privé `d`, base64url. */
  privateKey: string;
}

export interface EncryptOptions {
  /** Sel de 16 octets (test : vecteur RFC 8291 A). */
  salt?: Buffer;
  /** Clé privée éphémère du serveur (test). */
  serverPrivateKey?: Buffer;
  /** Taille d'enregistrement (défaut 4096 ; toujours un seul enregistrement). */
  recordSize?: number;
}

const KEY_INFO_PREFIX = Buffer.from('WebPush: info\0');
const CEK_INFO = Buffer.from('Content-Encoding: aes128gcm\0');
const NONCE_INFO = Buffer.from('Content-Encoding: nonce\0');

export function b64url(buffer: Buffer | Uint8Array): string {
  return Buffer.from(buffer).toString('base64url');
}
export function fromB64url(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

/** Chiffre `plaintext` pour l'abonnement : corps `aes128gcm` complet (en-tête + enregistrement). */
export function encryptPayload(
  plaintext: Buffer,
  keys: PushKeys,
  options: EncryptOptions = {},
): Buffer {
  const uaPublic = fromB64url(keys.p256dh);
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) {
    throw new Error('invalid p256dh key (expected 65-byte uncompressed point)');
  }
  const authSecret = fromB64url(keys.auth);
  if (authSecret.length !== 16) throw new Error('invalid auth secret (expected 16 bytes)');
  const salt = options.salt ?? randomBytes(16);
  const ecdh = createECDH('prime256v1');
  if (options.serverPrivateKey) ecdh.setPrivateKey(options.serverPrivateKey);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([KEY_INFO_PREFIX, uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', ecdhSecret, authSecret, keyInfo, 32));
  const { cek, nonce } = deriveRecordKeys(ikm, salt);
  const rs = options.recordSize ?? 4096;
  // Dernier (et unique) enregistrement : délimiteur 0x02, sans bourrage supplémentaire.
  if (plaintext.length + 1 + 16 > rs) throw new Error('payload too large for a single record');
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([
    cipher.update(Buffer.concat([plaintext, Buffer.from([0x02])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(rs, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, body]);
}

/** Déchiffrement côté « navigateur » (tests) : vérifie l'implémentation sans dépendre d'un tiers. */
export function decryptPayload(message: Buffer, uaPrivateKey: Buffer, authSecret: Buffer): Buffer {
  const salt = message.subarray(0, 16);
  const rs = message.readUInt32BE(16);
  const idLen = message[20] ?? 0;
  const asPublic = message.subarray(21, 21 + idLen);
  const record = message.subarray(21 + idLen);
  if (record.length > rs) throw new Error('multi-record messages are not supported');
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(uaPrivateKey);
  const uaPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(asPublic);
  const keyInfo = Buffer.concat([KEY_INFO_PREFIX, uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', ecdhSecret, authSecret, keyInfo, 32));
  const { cek, nonce } = deriveRecordKeys(ikm, salt);
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(record.subarray(record.length - 16));
  const padded = Buffer.concat([
    decipher.update(record.subarray(0, record.length - 16)),
    decipher.final(),
  ]);
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end -= 1;
  if (end < 0 || (padded[end] !== 0x02 && padded[end] !== 0x01)) throw new Error('bad padding');
  return padded.subarray(0, end);
}

function deriveRecordKeys(ikm: Buffer, salt: Buffer): { cek: Buffer; nonce: Buffer } {
  return {
    cek: Buffer.from(hkdfSync('sha256', ikm, salt, CEK_INFO, 16)),
    nonce: Buffer.from(hkdfSync('sha256', ikm, salt, NONCE_INFO, 12)),
  };
}

/** En-tête `Authorization: vapid t=<jwt>, k=<clé publique>` (RFC 8292 §3). */
export function vapidAuthorization(
  endpoint: string,
  keys: VapidKeys,
  subject: string,
  nowMs: number,
  ttlSec = 12 * 3600,
): string {
  const audience = new URL(endpoint).origin;
  const header = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(
    Buffer.from(
      JSON.stringify({ aud: audience, exp: Math.floor(nowMs / 1000) + ttlSec, sub: subject }),
    ),
  );
  const data = `${header}.${claims}`;
  const pub = fromB64url(keys.publicKey);
  const key = createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: keys.privateKey,
      x: b64url(pub.subarray(1, 33)),
      y: b64url(pub.subarray(33, 65)),
    },
    format: 'jwk',
  });
  const signature = cryptoSign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${data}.${b64url(signature)}, k=${keys.publicKey}`;
}

export interface SendOptions {
  ttlSec?: number;
  urgency?: 'very-low' | 'low' | 'normal' | 'high';
  topic?: string;
  subject?: string;
  timeoutMs?: number;
}

export type SendOutcome =
  | { ok: true; status: number }
  | { ok: false; status: number | null; gone: boolean; retryable: boolean; error: string };

/** Envoie un push chiffré ; `gone` = 404/410 (abonnement mort, à purger). */
export async function sendWebPush(
  fetchImpl: typeof fetch,
  subscription: { endpoint: string; keys: PushKeys },
  payload: Buffer,
  vapid: VapidKeys,
  nowMs: number,
  options: SendOptions = {},
): Promise<SendOutcome> {
  let body: Buffer;
  try {
    body = encryptPayload(payload, subscription.keys);
  } catch (error) {
    return { ok: false, status: null, gone: true, retryable: false, error: errorText(error) };
  }
  const headers: Record<string, string> = {
    'Content-Type': 'application/octet-stream',
    'Content-Encoding': 'aes128gcm',
    'Content-Length': String(body.length),
    TTL: String(options.ttlSec ?? 24 * 3600),
    Urgency: options.urgency ?? 'normal',
    Authorization: vapidAuthorization(
      subscription.endpoint,
      vapid,
      options.subject ?? 'mailto:admin@localhost',
      nowMs,
    ),
  };
  if (options.topic) headers.Topic = options.topic.slice(0, 32);
  try {
    const response = await fetchImpl(subscription.endpoint, {
      method: 'POST',
      headers,
      body: body as unknown as NonNullable<RequestInit['body']>,
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    });
    await response.arrayBuffer().catch(() => undefined);
    if (response.status >= 200 && response.status < 300) {
      return { ok: true, status: response.status };
    }
    const gone = response.status === 404 || response.status === 410;
    return {
      ok: false,
      status: response.status,
      gone,
      retryable: response.status === 429 || response.status >= 500,
      error: `HTTP ${String(response.status)}`,
    };
  } catch (error) {
    return { ok: false, status: null, gone: false, retryable: true, error: errorText(error) };
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
