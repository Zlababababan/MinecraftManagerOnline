/**
 * Frame binaire des transferts (doc 05 §8) : `[1 o version][16 o transferId][8 o offset u64 BE]
 * [données]`. Portable (Uint8Array/DataView, pas de `Buffer`) : utilisable par le panel, l'agent
 * et un éventuel client navigateur.
 */

export const FRAME_VERSION = 1;
export const FRAME_HEADER_SIZE = 1 + 16 + 8;

export interface TransferFrame {
  /** 32 caractères hexadécimaux. */
  transferId: string;
  /** Position du premier octet de `data` dans le fichier non compressé. */
  offset: number;
  data: Uint8Array;
}

const HEX = '0123456789abcdef';

export function encodeFrame(frame: TransferFrame): Uint8Array {
  if (!/^[0-9a-f]{32}$/.test(frame.transferId)) {
    throw new Error(`invalid transferId: ${frame.transferId}`);
  }
  if (!Number.isSafeInteger(frame.offset) || frame.offset < 0) {
    throw new Error(`invalid offset: ${String(frame.offset)}`);
  }
  const out = new Uint8Array(FRAME_HEADER_SIZE + frame.data.byteLength);
  out[0] = FRAME_VERSION;
  for (let i = 0; i < 16; i++) {
    out[1 + i] = parseInt(frame.transferId.slice(i * 2, i * 2 + 2), 16);
  }
  new DataView(out.buffer, out.byteOffset, out.byteLength).setBigUint64(
    17,
    BigInt(frame.offset),
    false,
  );
  out.set(frame.data, FRAME_HEADER_SIZE);
  return out;
}

/** Retourne `undefined` pour une frame inconnue (version, taille) plutôt que de lever. */
export function decodeFrame(buf: Uint8Array): TransferFrame | undefined {
  if (buf.byteLength < FRAME_HEADER_SIZE || buf[0] !== FRAME_VERSION) return undefined;
  let transferId = '';
  for (let i = 1; i <= 16; i++) {
    const b = buf[i] ?? 0;
    transferId += HEX[b >> 4] ?? '0';
    transferId += HEX[b & 15] ?? '0';
  }
  const offsetBig = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getBigUint64(
    17,
    false,
  );
  if (offsetBig > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
  return {
    transferId,
    offset: Number(offsetBig),
    data: buf.subarray(FRAME_HEADER_SIZE),
  };
}

/** Identifiant de transfert aléatoire (16 octets hex) à partir d'un générateur d'octets injecté. */
export function transferIdFromBytes(bytes: Uint8Array): string {
  if (bytes.byteLength < 16) throw new Error('16 random bytes expected');
  let id = '';
  for (let i = 0; i < 16; i++) {
    const b = bytes[i] ?? 0;
    id += HEX[b >> 4] ?? '0';
    id += HEX[b & 15] ?? '0';
  }
  return id;
}
