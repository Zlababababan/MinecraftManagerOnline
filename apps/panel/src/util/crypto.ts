/** Primitives : hachage SHA-256 (secrets d'agent, tokens de session, codes d'appairage), aléa. */
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Secret d'agent : 256 bits aléatoires en hexadécimal (64 caractères). */
export function generateAgentSecret(): string {
  return randomBytes(32).toString('hex');
}

/** Token de session : 256 bits, base64url (cookie). */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Alphabet sans caractères ambigus (pas de 0/O, 1/I/L, U/V). */
const PAIRING_ALPHABET = 'ABCDEFGHJKMNPQRSTWXYZ23456789';

/** Code d'appairage `MMOP-XXXX-XXXX` (doc 05 §3). */
export function generatePairingCode(): string {
  const pick = (): string => PAIRING_ALPHABET[randomInt(PAIRING_ALPHABET.length)] ?? 'A';
  const block = (): string => pick() + pick() + pick() + pick();
  return `MMOP-${block()}-${block()}`;
}

/** Normalise un code saisi (casse, espaces, tirets) avant hachage. */
export function normalizePairingCode(code: string): string {
  const raw = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const body = raw.startsWith('MMOP') ? raw.slice(4) : raw;
  return `MMOP-${body.slice(0, 4)}-${body.slice(4, 8)}`;
}

export function hashPairingCode(code: string): string {
  return sha256Hex(normalizePairingCode(code));
}

export function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
