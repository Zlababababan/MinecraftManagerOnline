/**
 * Lecteur zip/jar minimal, sans dépendance ni module natif (contrainte agent) : lit le répertoire
 * central par positions (pas de chargement du fichier entier — un `server.jar` bundler fait 45 Mo),
 * décompresse `store`/`deflate` via `node:zlib`. ZIP64 non supporté (jamais rencontré sur un jar MC).
 */
import type { FileHandle } from 'node:fs/promises';
import { open } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';

import type { JarHandle } from '../detection/fs.js';

interface CentralEntry {
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;
const MAX_ENTRIES = 200_000;

async function readAt(fh: FileHandle, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await fh.read(buf, done, length - done, position + done);
    if (bytesRead === 0) break;
    done += bytesRead;
  }
  return done === length ? buf : buf.subarray(0, done);
}

/** Ouvre un jar ; `undefined` si le fichier n'existe pas ou n'est pas un zip lisible. */
export async function openZip(path: string): Promise<JarHandle | undefined> {
  let fh: FileHandle;
  try {
    fh = await open(path, 'r');
  } catch {
    return undefined;
  }
  try {
    const { size } = await fh.stat();
    if (size < 22) {
      await fh.close();
      return undefined;
    }
    const tailLen = Math.min(size, 65_557);
    const tail = await readAt(fh, size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) {
      await fh.close();
      return undefined;
    }
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (
      count === 0xffff ||
      cdOffset === 0xffffffff ||
      cdOffset + cdSize > size ||
      count > MAX_ENTRIES
    ) {
      await fh.close();
      return undefined;
    }
    const cd = await readAt(fh, cdOffset, cdSize);
    const entries = new Map<string, CentralEntry>();
    let p = 0;
    for (let i = 0; i < count && p + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(p) !== CEN_SIG) break;
      const method = cd.readUInt16LE(p + 10);
      const compressedSize = cd.readUInt32LE(p + 20);
      const uncompressedSize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const localHeaderOffset = cd.readUInt32LE(p + 42);
      const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
      entries.set(name, { method, compressedSize, uncompressedSize, localHeaderOffset });
      p += 46 + nameLen + extraLen + commentLen;
    }
    let closed = false;
    return {
      has: (name) => entries.has(name),
      async readText(name, maxBytes = 1024 * 1024) {
        const e = entries.get(name);
        if (!e || closed) return undefined;
        if (e.method !== 0 && e.method !== 8) return undefined;
        const local = await readAt(fh, e.localHeaderOffset, 30);
        if (local.length < 30 || local.readUInt32LE(0) !== LOC_SIG) return undefined;
        const nameLen = local.readUInt16LE(26);
        const extraLen = local.readUInt16LE(28);
        const dataStart = e.localHeaderOffset + 30 + nameLen + extraLen;
        const raw = await readAt(fh, dataStart, e.compressedSize);
        let data: Buffer;
        try {
          data =
            e.method === 8 ? inflateRawSync(raw, { maxOutputLength: Math.max(maxBytes, 1) }) : raw;
        } catch (error) {
          // maxOutputLength dépassé → on garde ce qui a été produit si possible, sinon abandon
          const partial = (error as { buffer?: Buffer }).buffer;
          if (!partial) return undefined;
          data = partial;
        }
        return data.subarray(0, maxBytes).toString('utf8');
      },
      async close() {
        if (closed) return;
        closed = true;
        await fh.close();
      },
    };
  } catch {
    await fh.close().catch(() => undefined);
    return undefined;
  }
}
