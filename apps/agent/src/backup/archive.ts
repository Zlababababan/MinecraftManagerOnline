/**
 * Archives de sauvegarde `.tar.zst` / `.tar.gz` (spike n°3) : tar maison → zstd 3 (checksum) ou gzip
 * → fichier `.part` renommé à la fin ; SHA-256 de l'archive calculé à l'écriture. L'intégrité ne
 * repose jamais sur le codec : `verifyArchive()` relit le fichier et compare taille + SHA-256 au
 * manifeste avant toute restauration (un flux zstd tronqué serait accepté silencieusement par Node).
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { rename, rm, stat } from 'node:fs/promises';
import { Readable, Transform, pipeline } from 'node:stream';
import { promisify } from 'node:util';

import { createCompressStream, createDecompressStream, hasZstd } from '@mmo/shared/node';

import {
  extractTar,
  tarEntries,
  walkTree,
  type ExcludeFn,
  type ExtractResult,
} from '@mmo/shared/node';

const pipe = promisify(pipeline);

export type ArchiveCodec = 'zstd' | 'gzip';

/** Codec effectif : zstd si demandé et disponible, sinon gzip. */
export function chooseCodec(wanted: ArchiveCodec | undefined): ArchiveCodec {
  if (wanted === 'gzip') return 'gzip';
  return hasZstd() ? 'zstd' : 'gzip';
}

export function archiveExtension(codec: ArchiveCodec): string {
  return codec === 'zstd' ? '.tar.zst' : '.tar.gz';
}

/** Dossiers/fichiers jamais archivés (relatifs à la racine du serveur). */
export const DEFAULT_EXCLUDES = ['.mmo-trash', 'logs', 'crash-reports', 'session.lock'];

export function defaultExclude(extra: string[] = []): ExcludeFn {
  const names = new Set([...DEFAULT_EXCLUDES, ...extra]);
  return (rel) => {
    if (names.has(rel)) return true;
    // `world/session.lock` & co : verrou du monde, inutile et parfois verrouillé sous Windows
    return rel.endsWith('/session.lock') || rel.endsWith('.part');
  };
}

export interface CreateArchiveProgress {
  phase: 'inventory' | 'archiving';
  bytes: number;
  bytesTotal: number;
  files: number;
  filesTotal: number;
  current: string;
}

export interface CreateArchiveResult {
  sizeBytes: number;
  sha256: string;
  files: number;
  bytesRaw: number;
  skipped: string[];
}

/**
 * Crée `archivePath` (écrit en `.part` puis renommé). `shouldAbort` interrompt proprement et
 * supprime le `.part`.
 */
export async function createArchive(
  sourceDir: string,
  archivePath: string,
  codec: ArchiveCodec,
  options: {
    exclude?: ExcludeFn;
    onProgress?: (p: CreateArchiveProgress) => void;
    shouldAbort?: () => boolean;
  } = {},
): Promise<CreateArchiveResult> {
  const exclude = options.exclude ?? defaultExclude();
  options.onProgress?.({
    phase: 'inventory',
    bytes: 0,
    bytesTotal: 0,
    files: 0,
    filesTotal: 0,
    current: '',
  });
  const tree = await walkTree(sourceDir, exclude);
  const part = `${archivePath}.part`;
  const hash = createHash('sha256');
  let size = 0;
  const hasher = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      hash.update(chunk);
      size += chunk.byteLength;
      cb(null, chunk);
    },
  });
  try {
    await pipe(
      Readable.from(
        tarEntries(
          tree.entries,
          (p) => {
            options.onProgress?.({
              phase: 'archiving',
              bytes: p.bytes,
              bytesTotal: tree.bytes,
              files: p.files,
              filesTotal: tree.files,
              current: p.current,
            });
          },
          options.shouldAbort,
        ),
      ),
      createCompressStream(codec),
      hasher,
      createWriteStream(part),
    );
    await rename(part, archivePath);
  } catch (error) {
    await rm(part, { force: true }).catch(() => undefined);
    throw error;
  }
  return {
    sizeBytes: size,
    sha256: hash.digest('hex'),
    files: tree.files,
    bytesRaw: tree.bytes,
    skipped: tree.skipped,
  };
}

/** Relit l'archive : `{ ok: true }` si taille et SHA-256 correspondent au manifeste. */
export async function verifyArchive(
  archivePath: string,
  expected: { sizeBytes: number; sha256: string },
  options: { onProgress?: (bytes: number) => void; shouldAbort?: () => boolean } = {},
): Promise<{ ok: boolean; sizeBytes: number; sha256: string }> {
  const st = await stat(archivePath);
  const hash = createHash('sha256');
  let read = 0;
  const stream = createReadStream(archivePath, { highWaterMark: 1024 * 1024 });
  try {
    for await (const chunk of stream) {
      if (options.shouldAbort?.()) throw new Error('aborted');
      hash.update(chunk as Buffer);
      read += (chunk as Buffer).byteLength;
      options.onProgress?.(read);
    }
  } finally {
    stream.destroy();
  }
  const sha256 = hash.digest('hex');
  return {
    ok: st.size === expected.sizeBytes && sha256 === expected.sha256.toLowerCase(),
    sizeBytes: st.size,
    sha256,
  };
}

/** Extrait l'archive dans `dest` (dossiers créés). */
export async function extractArchive(
  archivePath: string,
  codec: ArchiveCodec,
  dest: string,
  options: {
    onProgress?: (p: { bytes: number; files: number; current: string }) => void;
    shouldAbort?: () => boolean;
  } = {},
): Promise<ExtractResult> {
  const input = createReadStream(archivePath, { highWaterMark: 1024 * 1024 });
  const decompress = createDecompressStream(codec);
  const stream = input.pipe(decompress);
  input.on('error', (error) => decompress.destroy(error));
  try {
    return await extractTar(stream as AsyncIterable<Uint8Array>, dest, options);
  } finally {
    input.destroy();
  }
}
