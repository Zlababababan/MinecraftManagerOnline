/**
 * Extraction zip minimale (phase 9, JRE Windows) : répertoire central lu par positions, entrées
 * `store`/`deflate` décompressées en flux (`node:zlib`), chemins jailés, `stripComponents` pour
 * ignorer le dossier racine (`jdk-17.0.12+7-jre/`). ZIP64 non supporté (les JRE font < 4 Gio).
 */
import { ProtocolError } from '@mmo/protocol';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createInflateRaw } from 'node:zlib';

import {
  DEFAULT_EXTRACT_MAX_BYTES,
  DEFAULT_EXTRACT_MAX_ENTRIES,
  assertExtractBudget,
  safeRelative,
} from '@mmo/shared/node';

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;
const MAX_ENTRIES = 500_000;

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  isDir: boolean;
  mode: number;
}

export interface ZipExtractResult {
  files: number;
  bytes: number;
  skipped: string[];
}

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

async function readCentralDirectory(fh: FileHandle): Promise<ZipEntry[]> {
  const { size } = await fh.stat();
  if (size < 22) throw new Error('zip: file too small');
  const tailLen = Math.min(size, 65_557);
  const tail = await readAt(fh, size - tailLen, tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('zip: end of central directory not found');
  const count = tail.readUInt16LE(eocd + 10);
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOffset = tail.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new Error('zip: ZIP64 not supported');
  if (cdOffset + cdSize > size || count > MAX_ENTRIES) throw new Error('zip: corrupt directory');
  const cd = await readAt(fh, cdOffset, cdSize);
  const entries: ZipEntry[] = [];
  let p = 0;
  for (let i = 0; i < count && p + 46 <= cd.length; i++) {
    if (cd.readUInt32LE(p) !== CEN_SIG) break;
    const versionMadeBy = cd.readUInt16LE(p + 4);
    const method = cd.readUInt16LE(p + 10);
    const compressedSize = cd.readUInt32LE(p + 20);
    const uncompressedSize = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const externalAttrs = cd.readUInt32LE(p + 38);
    const localHeaderOffset = cd.readUInt32LE(p + 42);
    const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
    // Mode POSIX dans les 16 bits hauts quand l'archive vient d'un Unix (versionMadeBy >> 8 === 3).
    const mode = versionMadeBy >> 8 === 3 ? (externalAttrs >>> 16) & 0o7777 : 0;
    entries.push({
      name,
      method,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      isDir: name.endsWith('/'),
      mode,
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Extrait `zipPath` dans `dest`. */
export async function extractZip(
  zipPath: string,
  dest: string,
  options: {
    stripComponents?: number;
    onProgress?: (p: { bytes: number; files: number; current: string }) => void;
    shouldAbort?: () => boolean;
    /** Phase 12 (doc 03 §6) : plafond d'octets réellement inflatés (défaut 64 Gio). */
    maxBytes?: number;
    maxEntries?: number;
  } = {},
): Promise<ZipExtractResult> {
  const strip = options.stripComponents ?? 0;
  const maxBytes = options.maxBytes ?? DEFAULT_EXTRACT_MAX_BYTES;
  const maxEntries = options.maxEntries ?? DEFAULT_EXTRACT_MAX_ENTRIES;
  let seen = 0;
  const skipped: string[] = [];
  let files = 0;
  let bytes = 0;
  const fh = await open(zipPath, 'r');
  try {
    const entries = await readCentralDirectory(fh);
    for (const e of entries) {
      if (options.shouldAbort?.()) throw new Error('aborted');
      let rel = safeRelative(e.name);
      if (rel !== undefined && strip > 0) {
        const parts = rel.split('/');
        rel = parts.length > strip ? parts.slice(strip).join('/') : undefined;
        if (rel === undefined) continue;
      }
      if (rel === undefined) {
        skipped.push(e.name);
        continue;
      }
      seen++;
      assertExtractBudget(bytes + e.uncompressedSize, seen, maxBytes, maxEntries);
      const abs = path.join(dest, ...rel.split('/'));
      if (e.isDir) {
        await mkdir(abs, { recursive: true });
        continue;
      }
      if (e.method !== 0 && e.method !== 8) {
        skipped.push(e.name);
        continue;
      }
      const local = await readAt(fh, e.localHeaderOffset, 30);
      if (local.length < 30 || local.readUInt32LE(0) !== LOC_SIG) {
        throw new Error(`zip: bad local header for ${e.name}`);
      }
      const nameLen = local.readUInt16LE(26);
      const extraLen = local.readUInt16LE(28);
      const dataStart = e.localHeaderOffset + 30 + nameLen + extraLen;
      await mkdir(path.dirname(abs), { recursive: true });
      const mode = process.platform !== 'win32' && e.mode !== 0 ? e.mode : undefined;
      const input =
        e.compressedSize === 0
          ? undefined
          : createReadStream(zipPath, { start: dataStart, end: dataStart + e.compressedSize - 1 });
      const output = createWriteStream(abs, mode === undefined ? {} : { mode });
      if (input === undefined) {
        await new Promise<void>((resolve, reject) => {
          output.end((err: Error | null | undefined) => {
            if (err) reject(err);
            else resolve();
          });
        });
      } else if (e.method === 8) {
        // Un zip menteur (taille déclarée < réelle) est stoppé sur le flux inflaté, pas sur l'en-tête.
        let inflated = 0;
        const budget = maxBytes - bytes;
        const guard = new Transform({
          transform(chunk: Buffer, _enc, cb) {
            inflated += chunk.byteLength;
            if (inflated > budget) {
              cb(
                new ProtocolError('E_TOO_LARGE', 'archive exceeds the allowed extraction size', {
                  details: { bytes: bytes + inflated, maxBytes, entry: e.name },
                }),
              );
              return;
            }
            cb(null, chunk);
          },
        });
        await pipeline(input, createInflateRaw(), guard, output);
      } else {
        await pipeline(input, output);
      }
      files++;
      bytes += e.uncompressedSize;
      options.onProgress?.({ bytes, files, current: rel });
    }
  } finally {
    await fh.close();
  }
  return { files, bytes, skipped };
}
