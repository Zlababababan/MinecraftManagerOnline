/** ULID (26 caractères Crockford base32) — sans dépendance, utilisable panel/agent/navigateur. */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function randomBytes(n: number): Uint8Array {
  const bytes = new Uint8Array(n);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

/** Génère un ULID : 48 bits de temps (epoch ms) + 80 bits aléatoires. */
export function ulid(now: number = Date.now()): string {
  let time = Math.floor(now);
  let out = '';
  for (let i = 0; i < 10; i++) {
    out = (ALPHABET[time % 32] ?? '0') + out;
    time = Math.floor(time / 32);
  }
  const rnd = randomBytes(16);
  for (let i = 0; i < 16; i++) out += ALPHABET[(rnd[i] ?? 0) & 31] ?? '0';
  return out;
}

/** Extrait l'horodatage (epoch ms) encodé dans un ULID. */
export function ulidTime(id: string): number {
  let time = 0;
  for (let i = 0; i < 10; i++) time = time * 32 + ALPHABET.indexOf(id.charAt(i));
  return time;
}
